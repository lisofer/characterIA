import os
import io
import hmac
import json
import uuid
import time
import math
import base64
import hashlib
import sqlite3
import tempfile
import shutil
import subprocess
import statistics
import threading
from array import array
from pathlib import Path
from concurrent.futures import ThreadPoolExecutor

import httpx
import msgpack
from PIL import Image, ImageOps, UnidentifiedImageError
from fastapi import FastAPI, Request, UploadFile, File, Form, HTTPException, Depends
from fastapi.responses import FileResponse, JSONResponse, HTMLResponse
from pydantic import BaseModel, Field

BASE = Path(__file__).resolve().parent
DATA = Path(os.getenv("DATA_DIR") or os.getenv("RAILWAY_VOLUME_MOUNT_PATH") or BASE / "data").resolve()
ASSETS = DATA / "assets"
OUTPUTS = DATA / "outputs"
TEMP = DATA / "tmp"
DB = DATA / "studio.sqlite3"
PASSWORD = os.getenv("APP_PASSWORD", "")
SECRET = os.getenv("SESSION_SECRET", "")
FISH_KEY = os.getenv("FISH_API_KEY", "")
GEMINI_KEY = os.getenv("GEMINI_API_KEY", "")
FISH_MODEL = os.getenv("FISH_MODEL", "s2.1-pro")
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")
executor = ThreadPoolExecutor(max_workers=2, thread_name_prefix="studio")
for directory in (DATA, ASSETS, OUTPUTS, TEMP):
    directory.mkdir(parents=True, exist_ok=True)

app = FastAPI(title="Persona Studio Audio & Video", docs_url=None, redoc_url=None, openapi_url=None)

def connection():
    db = sqlite3.connect(DB, timeout=30)
    db.row_factory = sqlite3.Row
    db.execute("PRAGMA busy_timeout=30000")
    return db

def init_db():
    with connection() as db:
        db.executescript("""
        CREATE TABLE IF NOT EXISTS characters (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, voice_id TEXT NOT NULL DEFAULT '',
            reference_file TEXT NOT NULL DEFAULT '', reference_text TEXT NOT NULL DEFAULT '',
            notes TEXT NOT NULL DEFAULT '', created_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS outfits (
            id TEXT PRIMARY KEY, character_id TEXT NOT NULL,
            name TEXT NOT NULL, created_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS backgrounds (
            id TEXT PRIMARY KEY, name TEXT NOT NULL, file TEXT NOT NULL, created_at REAL NOT NULL
        );
        CREATE TABLE IF NOT EXISTS generations (
            id TEXT PRIMARY KEY, character_id TEXT NOT NULL, outfit_id TEXT NOT NULL,
            background_id TEXT NOT NULL DEFAULT '', text TEXT NOT NULL,
            status TEXT NOT NULL, error TEXT NOT NULL DEFAULT '',
            audio_file TEXT NOT NULL DEFAULT '', video_file TEXT NOT NULL DEFAULT '',
            created_at REAL NOT NULL
        );
        CREATE INDEX IF NOT EXISTS idx_gen_time ON generations(created_at DESC);
        """)
        db.execute("UPDATE generations SET status='interrupted', error='Trabajo interrumpido por un reinicio; podés reintentarlo.' WHERE status IN ('queued','generating','rendering')")
init_db()

def record(table, ident):
    if table not in ("characters", "outfits", "backgrounds", "generations"):
        raise HTTPException(400, "Tabla inválida")
    with connection() as db:
        row = db.execute("SELECT * FROM " + table + " WHERE id=?", (ident,)).fetchone()
    if not row:
        raise HTTPException(404, "No se encontró el elemento")
    return dict(row)

def rows(table, order="created_at DESC"):
    with connection() as db:
        return [dict(r) for r in db.execute("SELECT * FROM " + table + " ORDER BY " + order).fetchall()]

def change(sql, params=()):
    with connection() as db:
        db.execute(sql, params)
        db.commit()

def new_id():
    return uuid.uuid4().hex

def token_make():
    payload = str(int(time.time() + 90 * 86400))
    signature = hmac.new(SECRET.encode(), payload.encode(), hashlib.sha256).hexdigest()
    return payload + "." + signature

def authenticated(request: Request):
    if not SECRET or not PASSWORD:
        return False
    token = request.cookies.get("studio_session", "")
    try:
        exp, digest = token.split(".", 1)
        valid = hmac.new(SECRET.encode(), exp.encode(), hashlib.sha256).hexdigest()
        return hmac.compare_digest(digest, valid) and int(exp) >= time.time()
    except (ValueError, TypeError):
        return False

def auth(request: Request):
    if not authenticated(request):
        raise HTTPException(status_code=401, detail="Iniciá sesión para continuar.")

login_attempts = {}
login_lock = threading.Lock()

class Login(BaseModel):
    password: str

@app.post("/api/login")
def login(payload: Login, request: Request):
    if not PASSWORD or not SECRET:
        raise HTTPException(503, "Configurá APP_PASSWORD y SESSION_SECRET en Railway.")
    ip = request.client.host if request.client else "unknown"
    now = time.time()
    with login_lock:
        attempts = [t for t in login_attempts.get(ip, []) if now - t < 600]
        if len(attempts) >= 10:
            raise HTTPException(429, "Demasiados intentos. Volvé a intentar en unos minutos.")
        if not hmac.compare_digest(payload.password, PASSWORD):
            attempts.append(now)
            login_attempts[ip] = attempts
            raise HTTPException(401, "Clave incorrecta.")
        login_attempts.pop(ip, None)
    resp = JSONResponse({"ok": True})
    https = request.headers.get("x-forwarded-proto", request.url.scheme) == "https"
    resp.set_cookie("studio_session", token_make(), httponly=True, secure=https,
                    samesite="lax", max_age=90 * 86400, path="/")
    return resp

@app.post("/api/logout")
def logout(_: None = Depends(auth)):
    resp = JSONResponse({"ok": True})
    resp.delete_cookie("studio_session", path="/")
    return resp

@app.get("/")
def homepage():
    return FileResponse(BASE / "index.html", headers={"Cache-Control": "no-store"})

@app.get("/api/state")
def state(_: None = Depends(auth)):
    characters = rows("characters", "name COLLATE NOCASE")
    for c in characters:
        c.pop("reference_file", None)
    return {
        "characters": characters, "outfits": rows("outfits"),
        "backgrounds": rows("backgrounds"), "generations": rows("generations"),
        "fish_configured": bool(FISH_KEY), "gemini_configured": bool(GEMINI_KEY)
    }

async def read_bounded(file: UploadFile, max_bytes: int):
    data = await file.read(max_bytes + 1)
    if not data or len(data) > max_bytes:
        raise HTTPException(400, "Archivo vacío o demasiado grande.")
    return data

@app.post("/api/characters")
async def character_create(name: str = Form(...), voice_id: str = Form(""),
                           reference_text: str = Form(""), notes: str = Form(""),
                           reference: UploadFile | None = File(None),
                           _: None = Depends(auth)):
    name = name.strip()[:80]
    voice_id = voice_id.strip()[:150]
    reference_text = reference_text.strip()[:2500]
    if not name:
        raise HTTPException(400, "Ingresá el nombre del personaje.")
    if not voice_id and (reference is None or not reference_text):
        raise HTTPException(400, "Ingresá el ID de voz de Fish o una muestra con su transcripción.")
    char_id = new_id()
    ref_file = ""
    if reference:
        raw = await read_bounded(reference, 20 * 1024 * 1024)
        ext = Path(reference.filename or "").suffix.lower()
        if ext not in (".mp3", ".wav", ".m4a", ".ogg", ".flac"):
            raise HTTPException(400, "La muestra debe ser MP3, WAV, M4A, OGG o FLAC.")
        directory = ASSETS / "characters" / char_id
        directory.mkdir(parents=True, exist_ok=True)
        ref_file = str(directory / ("reference" + ext))
        Path(ref_file).write_bytes(raw)
    change("INSERT INTO characters VALUES (?,?,?,?,?,?,?)",
           (char_id, name, voice_id, ref_file, reference_text, notes.strip()[:1200], time.time()))
    return {"id": char_id}

class EditCharacter(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    voice_id: str = Field(default="", max_length=150)
    reference_text: str = Field(default="", max_length=2500)
    notes: str = Field(default="", max_length=1200)

@app.put("/api/characters/{char_id}")
def character_edit(char_id: str, payload: EditCharacter, _: None = Depends(auth)):
    char = record("characters", char_id)
    if not payload.voice_id.strip() and not char["reference_file"]:
        raise HTTPException(400, "Este personaje necesita ID de voz o muestra.")
    change("UPDATE characters SET name=?, voice_id=?, reference_text=?, notes=? WHERE id=?",
           (payload.name.strip(), payload.voice_id.strip(), payload.reference_text.strip(), payload.notes.strip(), char_id))
    return {"ok": True}

@app.post("/api/characters/{char_id}/reference")
async def reference_update(char_id: str, reference_text: str = Form(...),
                           reference: UploadFile = File(...), _: None = Depends(auth)):
    record("characters", char_id)
    if not reference_text.strip():
        raise HTTPException(400, "La transcripción de la muestra es obligatoria.")
    raw = await read_bounded(reference, 20 * 1024 * 1024)
    ext = Path(reference.filename or "").suffix.lower()
    if ext not in (".mp3", ".wav", ".m4a", ".ogg", ".flac"):
        raise HTTPException(400, "Formato de audio no permitido.")
    directory = ASSETS / "characters" / char_id
    directory.mkdir(parents=True, exist_ok=True)
    filename = directory / ("ref_" + new_id() + ext)
    filename.write_bytes(raw)
    change("UPDATE characters SET reference_file=?, reference_text=? WHERE id=?",
           (str(filename), reference_text.strip()[:2500], char_id))
    return {"ok": True}

@app.post("/api/characters/{char_id}/outfits")
async def outfit_create(char_id: str, name: str = Form(...), images: list[UploadFile] = File(...),
                        _: None = Depends(auth)):
    record("characters", char_id)
    if len(images) != 8:
        raise HTTPException(400, "Cada conjunto necesita exactamente 8 archivos PNG.")
    set_id = new_id()
    directory = ASSETS / "characters" / char_id / "outfits" / set_id
    directory.mkdir(parents=True, exist_ok=True)
    try:
        for index, item in enumerate(sorted(images, key=lambda a: (a.filename or "").casefold())):
            data = await read_bounded(item, 12 * 1024 * 1024)
            if Path(item.filename or "").suffix.lower() != ".png":
                raise HTTPException(400, "Las 8 imágenes tienen que ser PNG.")
            try:
                with Image.open(io.BytesIO(data)) as picture:
                    picture.verify()
                with Image.open(io.BytesIO(data)) as picture:
                    if picture.width * picture.height > 20_000_000:
                        raise HTTPException(400, "Una imagen supera el tamaño máximo.")
            except (UnidentifiedImageError, OSError):
                raise HTTPException(400, "Uno de los PNG es inválido.")
            (directory / f"{index:02d}.png").write_bytes(data)
    except Exception:
        shutil.rmtree(directory, ignore_errors=True)
        raise
    change("INSERT INTO outfits VALUES (?,?,?,?)",
           (set_id, char_id, name.strip()[:80] or "Nuevo conjunto", time.time()))
    return {"id": set_id}

@app.get("/api/outfits/{set_id}/image/{index}")
def image_outfit(set_id: str, index: int, _: None = Depends(auth)):
    outfit = record("outfits", set_id)
    if index not in range(8):
        raise HTTPException(404, "Imagen no encontrada")
    path = ASSETS / "characters" / outfit["character_id"] / "outfits" / set_id / f"{index:02d}.png"
    if not path.is_file():
        raise HTTPException(404, "Imagen no encontrada")
    return FileResponse(path, media_type="image/png")

@app.post("/api/backgrounds")
async def background_create(name: str = Form(...), image: UploadFile = File(...),
                            _: None = Depends(auth)):
    raw = await read_bounded(image, 20 * 1024 * 1024)
    ident = new_id()
    path = ASSETS / "backgrounds" / (ident + ".png")
    path.parent.mkdir(parents=True, exist_ok=True)
    try:
        with Image.open(io.BytesIO(raw)) as im:
            if im.width * im.height > 25_000_000:
                raise HTTPException(400, "Fondo demasiado grande.")
            converted = ImageOps.exif_transpose(im).convert("RGB")
            converted.save(path, "PNG", optimize=True)
    except (UnidentifiedImageError, OSError):
        raise HTTPException(400, "La imagen del fondo es inválida.")
    change("INSERT INTO backgrounds VALUES (?,?,?,?)",
           (ident, name.strip()[:80] or "Fondo", str(path), time.time()))
    return {"id": ident}

@app.get("/api/backgrounds/{ident}/image")
def image_background(ident: str, _: None = Depends(auth)):
    bg = record("backgrounds", ident)
    return FileResponse(bg["file"], media_type="image/png")

class GenerationInput(BaseModel):
    character_id: str
    outfit_id: str
    background_id: str = ""
    text: str = Field(min_length=1, max_length=3000)

def valid_generation(item: GenerationInput):
    record("characters", item.character_id)
    outfit = record("outfits", item.outfit_id)
    if outfit["character_id"] != item.character_id:
        raise HTTPException(400, "El conjunto no pertenece al personaje.")
    if item.background_id:
        record("backgrounds", item.background_id)

@app.post("/api/generations")
def generation_create(item: GenerationInput, _: None = Depends(auth)):
    if not FISH_KEY:
        raise HTTPException(503, "Falta configurar FISH_API_KEY.")
    valid_generation(item)
    text = item.text.strip()
    if not text:
        raise HTTPException(400, "El texto está vacío.")
    ident = new_id()
    change("INSERT INTO generations VALUES (?,?,?,?,?,?,?,?,?,?)",
           (ident, item.character_id, item.outfit_id, item.background_id, text,
            "queued", "", "", "", time.time()))
    executor.submit(generate_speech, ident)
    return {"id": ident}

def generate_speech(ident: str):
    try:
        job = record("generations", ident)
        character = record("characters", job["character_id"])
        change("UPDATE generations SET status='generating', error='' WHERE id=?", (ident,))
        params = {"text": job["text"], "format": "mp3"}
        headers = {"Authorization": "Bearer " + FISH_KEY, "model": FISH_MODEL}
        if character["voice_id"]:
            params["reference_id"] = character["voice_id"]
            headers["Content-Type"] = "application/json"
            payload = json.dumps(params).encode()
        else:
            if not character["reference_file"] or not character["reference_text"]:
                raise RuntimeError("Falta la muestra de voz o su transcripción.")
            raw = Path(character["reference_file"]).read_bytes()
            params["references"] = [{"audio": raw, "text": character["reference_text"]}]
            headers["Content-Type"] = "application/msgpack"
            payload = msgpack.packb(params, use_bin_type=True)
        with httpx.Client(timeout=httpx.Timeout(240, connect=20), follow_redirects=False) as client:
            response = client.post("https://api.fish.audio/v1/tts", headers=headers, content=payload)
            if response.status_code >= 400:
                raise RuntimeError(f"Fish HTTP {response.status_code}: " + response.text[:280])
            if not response.content or len(response.content) < 100:
                raise RuntimeError("Fish devolvió un audio vacío.")
            if not response.headers.get("content-type", "").lower().startswith(("audio/", "application/octet-stream")):
                if response.content[:3] != b"ID3" and response.content[:1] != b"\xff":
                    raise RuntimeError("Fish no devolvió un archivo de audio válido.")
            audio_file = OUTPUTS / (ident + ".mp3")
            audio_file.write_bytes(response.content)
        change("UPDATE generations SET status='ready', audio_file=? WHERE id=?", (str(audio_file), ident))
    except Exception as error:
        change("UPDATE generations SET status='failed', error=? WHERE id=?",
               (str(error)[:500], ident))

def amplitudes(audio: Path):
    proc = subprocess.run(
        ["ffmpeg", "-v", "error", "-i", str(audio), "-f", "s16le", "-ac", "1",
         "-ar", "8000", "pipe:1"], stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        timeout=90, check=True)
    raw = proc.stdout
    samples = array("h")
    samples.frombytes(raw[:len(raw) - len(raw) % 2])
    window = 960  # ~120ms
    levels = []
    for start in range(0, len(samples), window):
        part = samples[start:start + window]
        if not part:
            break
        # Approximate RMS; energy follows real voiced passages.
        levels.append(math.sqrt(sum(x*x for x in part) / len(part)))
    return levels, len(samples) / 8000

def render_video(ident: str):
    folder = None
    try:
        job = record("generations", ident)
        outfit = record("outfits", job["outfit_id"])
        if not job["audio_file"] or not Path(job["audio_file"]).is_file():
            raise RuntimeError("Generá primero el MP3.")
        change("UPDATE generations SET status='rendering', error='' WHERE id=?", (ident,))
        folder = Path(tempfile.mkdtemp(prefix="render_", dir=TEMP))
        width, height = 720, 1280
        if job["background_id"]:
            bg = record("backgrounds", job["background_id"])
            with Image.open(bg["file"]) as im:
                base = ImageOps.fit(im.convert("RGB"), (width, height), method=Image.Resampling.LANCZOS).convert("RGBA")
        else:
            # H.264 MP4 has no alpha channel: no selected photo = solid neutral canvas.
            base = Image.new("RGBA", (width, height), "#131722")
        outfit_dir = ASSETS / "characters" / outfit["character_id"] / "outfits" / outfit["id"]
        for index in range(8):
            with Image.open(outfit_dir / f"{index:02d}.png") as source:
                sprite = source.convert("RGBA")
                sprite.thumbnail((width, height), Image.Resampling.LANCZOS)
            composed = base.copy()
            x = (width - sprite.width) // 2
            y = height - sprite.height
            composed.alpha_composite(sprite, (x, y))
            composed.convert("RGB").save(folder / f"frame_{index}.png", optimize=False)
        levels, duration = amplitudes(Path(job["audio_file"]))
        if not levels:
            raise RuntimeError("No se pudo analizar la voz del MP3.")
        peak = max(levels)
        # 0 = descanso; 1..7 = speaking mouth sprites based on loudness and movement.
        timeline = []
        for i, level in enumerate(levels):
            if level < max(110, peak * 0.075):
                pose = 0
            else:
                strength = min(6, int(6 * level / max(peak * .80, 1)))
                pose = 1 + min(6, max(0, strength + (i % 3 - 1)))
            if timeline and timeline[-1][0] == pose:
                timeline[-1][1] += 1
            else:
                timeline.append([pose, 1])
        lines = ["ffconcat version 1.0"]
        for pose, count in timeline:
            frame = (folder / f"frame_{pose}.png").as_posix()
            lines += [f"file '{frame}'", f"duration {count * 0.12:.5f}"]
        lines.append(f"file '{(folder / f'frame_{timeline[-1][0]}.png').as_posix()}'")
        seq = folder / "timeline.ffconcat"
        seq.write_text("\n".join(lines) + "\n", encoding="utf-8")
        output = OUTPUTS / (ident + ".mp4")
        process = subprocess.run(
            ["ffmpeg", "-hide_banner", "-loglevel", "error", "-y",
             "-f", "concat", "-safe", "0", "-i", str(seq),
             "-i", job["audio_file"], "-vf", "fps=24,format=yuv420p",
             "-map", "0:v:0", "-map", "1:a:0", "-c:v", "libx264",
             "-preset", "veryfast", "-crf", "23", "-threads", "2",
             "-c:a", "aac", "-b:a", "160k", "-movflags", "+faststart",
             "-t", f"{duration:.3f}", str(output)],
            capture_output=True, text=True, timeout=600)
        if process.returncode or not output.exists() or output.stat().st_size < 1000:
            raise RuntimeError("FFmpeg: " + process.stderr[-400:])
        change("UPDATE generations SET status='ready', video_file=? WHERE id=?", (str(output), ident))
    except Exception as error:
        change("UPDATE generations SET status='video_failed', error=? WHERE id=?",
               (str(error)[:500], ident))
    finally:
        if folder:
            shutil.rmtree(folder, ignore_errors=True)

@app.post("/api/generations/{ident}/video")
def video_start(ident: str, _: None = Depends(auth)):
    job = record("generations", ident)
    if job["video_file"] and Path(job["video_file"]).is_file():
        return {"ok": True, "status": "ready"}
    if job["status"] == "rendering":
        return {"ok": True, "status": "rendering"}
    if not job["audio_file"] or not Path(job["audio_file"]).is_file():
        raise HTTPException(409, "Primero esperá a que termine el MP3.")
    change("UPDATE generations SET status='rendering', error='' WHERE id=?", (ident,))
    executor.submit(render_video, ident)
    return {"ok": True, "status": "rendering"}

@app.post("/api/generations/{ident}/retry")
def retry_generation(ident: str, _: None = Depends(auth)):
    job = record("generations", ident)
    if job["status"] not in ("failed", "interrupted"):
        raise HTTPException(409, "Este trabajo no necesita reintento.")
    if not FISH_KEY:
        raise HTTPException(503, "Falta configurar FISH_API_KEY.")
    change("UPDATE generations SET status='queued', error='' WHERE id=?", (ident,))
    executor.submit(generate_speech, ident)
    return {"ok": True}

@app.get("/api/generations/{ident}/file/{kind}")
def output_file(ident: str, kind: str, download: int = 0, _: None = Depends(auth)):
    job = record("generations", ident)
    if kind not in ("mp3", "mp4"):
        raise HTTPException(404, "Formato desconocido.")
    path = Path(job["audio_file"] if kind == "mp3" else job["video_file"])
    if not str(path) or not path.is_file():
        raise HTTPException(404, "Archivo todavía no disponible.")
    return FileResponse(path, media_type="audio/mpeg" if kind == "mp3" else "video/mp4",
                        filename=f"{ident[:8]}.{kind}" if download else None,
                        content_disposition_type="attachment" if download else "inline")

class ScriptInput(BaseModel):
    character_id: str
    idea: str = Field(min_length=1, max_length=1200)

@app.post("/api/script")
def script_assist(data: ScriptInput, _: None = Depends(auth)):
    if not GEMINI_KEY:
        raise HTTPException(503, "Falta configurar GEMINI_API_KEY.")
    character = record("characters", data.character_id)
    payload = {
      "contents": [{"role": "user", "parts": [{"text": (
        "Escribí solamente un texto breve para que un personaje lo diga en voz alta. "
        "Español argentino natural, sin acotaciones ni comillas salvo que se pidan. "
        "Personaje: " + character["name"] + ". Estilo: " + character["notes"] +
        ". Idea indicada por el usuario: " + data.idea
      )}]}],
      "generationConfig": {"temperature": .85, "maxOutputTokens": 550}
    }
    with httpx.Client(timeout=45) as client:
        response = client.post(
           "https://generativelanguage.googleapis.com/v1beta/models/" + GEMINI_MODEL + ":generateContent",
           headers={"x-goog-api-key": GEMINI_KEY},
           json=payload)
    if response.status_code != 200:
        raise HTTPException(502, "Gemini HTTP " + str(response.status_code) + ": " + response.text[:250])
    try:
        result = "".join(p.get("text", "") for p in response.json()["candidates"][0]["content"]["parts"]).strip()
    except (KeyError, IndexError, ValueError):
        raise HTTPException(502, "Gemini no devolvió un texto válido.")
    return {"text": result[:3000]}

@app.get("/health")
def health():
    return {"ok": True}
