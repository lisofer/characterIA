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
from lip_sync import build_timeline, event_durations, SLOTS
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
FISH_MODEL = os.getenv("FISH_MODEL", "s2.1-pro-free")
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
        for table, columns in {
            "characters": [
                ("mouth_intensity", "INTEGER NOT NULL DEFAULT 45"),
                ("voice_delay", "INTEGER NOT NULL DEFAULT 0"),
                ("auto_blink", "INTEGER NOT NULL DEFAULT 1")],
            "generations": [("sync_file", "TEXT NOT NULL DEFAULT ''"),
                            ("webm_file", "TEXT NOT NULL DEFAULT ''")]
        }.items():
            existing = {row[1] for row in db.execute("PRAGMA table_info(" + table + ")")}
            for name, sql_type in columns:
                if name not in existing:
                    db.execute("ALTER TABLE " + table + " ADD COLUMN " + name + " " + sql_type)
        db.execute("UPDATE generations SET status='interrupted', error='Trabajo interrumpido por un reinicio; podés reintentarlo.' WHERE status IN ('queued','generating')")
        db.execute("UPDATE generations SET status='video_failed', error='Exportación MP4 interrumpida por un reinicio.' WHERE status='rendering'")
        db.execute("UPDATE generations SET status='webm_failed', error='Exportación WebM interrumpida por un reinicio.' WHERE status='rendering_webm'")
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

@app.get("/mobile-player.js")
def mobile_player_script():
    return FileResponse(BASE / "mobile-player.js", media_type="text/javascript", headers={"Cache-Control":"no-store"})

@app.get("/api/generations")
def generation_list(_: None = Depends(auth)):
    return {"generations": rows("generations")}

@app.get("/api/state")
def state(_: None = Depends(auth)):
    characters = rows("characters", "name COLLATE NOCASE")
    for c in characters:
        c.pop("reference_file", None)
    return {
        "characters": characters, "outfits": outfit_rows(),
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
                           mouth_intensity: int = Form(45), voice_delay: int = Form(0),
                           auto_blink: bool = Form(False),
                           _: None = Depends(auth)):
    if not 20 <= mouth_intensity <= 85 or not -100 <= voice_delay <= 160:
        raise HTTPException(400, "Ajustes de sincronización fuera del rango permitido.")
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
    change("INSERT INTO characters (id,name,voice_id,reference_file,reference_text,notes,created_at,mouth_intensity,voice_delay,auto_blink) VALUES (?,?,?,?,?,?,?,?,?,?)",
           (char_id, name, voice_id, ref_file, reference_text, notes.strip()[:1200], time.time(),
            mouth_intensity, voice_delay, int(auto_blink)))
    return {"id": char_id}

class EditCharacter(BaseModel):
    name: str = Field(min_length=1, max_length=80)
    voice_id: str = Field(default="", max_length=150)
    reference_text: str = Field(default="", max_length=2500)
    notes: str = Field(default="", max_length=1200)
    mouth_intensity: int = Field(default=45, ge=20, le=85)
    voice_delay: int = Field(default=0, ge=-100, le=160)
    auto_blink: bool = True

@app.put("/api/characters/{char_id}")
def character_edit(char_id: str, payload: EditCharacter, _: None = Depends(auth)):
    char = record("characters", char_id)
    if not payload.voice_id.strip() and not char["reference_file"]:
        raise HTTPException(400, "Este personaje necesita ID de voz o muestra.")
    change("UPDATE characters SET name=?, voice_id=?, reference_text=?, notes=?, mouth_intensity=?, voice_delay=?, auto_blink=? WHERE id=?",
           (payload.name.strip(), payload.voice_id.strip(), payload.reference_text.strip(), payload.notes.strip(),
            payload.mouth_intensity, payload.voice_delay, int(payload.auto_blink), char_id))
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


def outfit_dir(outfit):
    return ASSETS / "characters" / outfit["character_id"] / "outfits" / outfit["id"]

def outfit_rows():
    result = rows("outfits")
    for outfit in result:
        folder = outfit_dir(outfit)
        outfit["slots"] = [(folder / f"{i:02d}.png").is_file() for i in range(8)]
        outfit["complete"] = all(outfit["slots"])
    return result

async def save_png(upload: UploadFile, path: Path):
    raw = await read_bounded(upload, 12 * 1024 * 1024)
    if Path(upload.filename or "").suffix.lower() != ".png":
        raise HTTPException(400, "Las imágenes deben ser PNG.")
    try:
        with Image.open(io.BytesIO(raw)) as image:
            image.verify()
        with Image.open(io.BytesIO(raw)) as image:
            if image.width * image.height > 20_000_000:
                raise HTTPException(400, "Imagen demasiado grande.")
            if image.mode not in ("RGBA", "RGB", "P", "LA"):
                raise HTTPException(400, "Imagen PNG no compatible.")
    except (UnidentifiedImageError, OSError):
        raise HTTPException(400, "PNG inválido.")
    path.parent.mkdir(parents=True, exist_ok=True)
    stage = path.with_suffix(".incoming")
    stage.write_bytes(raw)
    stage.replace(path)

@app.post("/api/characters/{char_id}/outfits")
async def outfit_create(char_id: str, name: str = Form(...),
                        images: list[UploadFile] | None = File(None),
                        _: None = Depends(auth)):
    record("characters", char_id)
    if images and len(images) != 8:
        raise HTTPException(400, "Si cargás imágenes juntas, deben ser exactamente ocho.")
    set_id = new_id()
    directory = ASSETS / "characters" / char_id / "outfits" / set_id
    directory.mkdir(parents=True, exist_ok=True)
    try:
        if images:
            for index, item in enumerate(sorted(images, key=lambda a: (a.filename or "").casefold())):
                await save_png(item, directory / f"{index:02d}.png")
    except Exception:
        shutil.rmtree(directory, ignore_errors=True)
        raise
    change("INSERT INTO outfits VALUES (?,?,?,?)",
           (set_id, char_id, name.strip()[:80] or "Nuevo conjunto", time.time()))
    return {"id": set_id}

@app.post("/api/outfits/{set_id}/slot/{index}")
async def image_slot_upload(set_id: str, index: int, image: UploadFile = File(...),
                            _: None = Depends(auth)):
    if not 0 <= index < 8:
        raise HTTPException(400, "Casilla inválida.")
    outfit = record("outfits", set_id)
    await save_png(image, outfit_dir(outfit) / f"{index:02d}.png")
    return {"ok": True, "index": index}

@app.get("/api/outfits/{set_id}/image/{index}")
def image_outfit(set_id: str, index: int, _: None = Depends(auth)):
    outfit = record("outfits", set_id)
    if index not in range(8):
        raise HTTPException(404, "Imagen no encontrada")
    path = outfit_dir(outfit) / f"{index:02d}.png"
    if not path.is_file():
        raise HTTPException(404, "Esta casilla todavía no tiene una imagen.")
    return FileResponse(path, media_type="image/png", headers={"Cache-Control": "no-store"})

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
    change("INSERT INTO generations (id,character_id,outfit_id,background_id,text,status,error,audio_file,video_file,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
           (ident, item.character_id, item.outfit_id, item.background_id, text,
            "queued", "", "", "", time.time()))
    executor.submit(generate_speech, ident)
    return {"id": ident}

def generate_speech(ident: str):
    try:
        job = record("generations", ident)
        character = record("characters", job["character_id"])
        change("UPDATE generations SET status='generating', error='' WHERE id=?", (ident,))
        params = {"text": job["text"], "format": "mp3", "latency": "balanced",
                  "chunk_length": 150, "prosody": {"speed": 1, "volume": 0, "normalize_loudness": True},
                  "temperature": .7, "top_p": .7}
        headers = {"Authorization": "Bearer " + FISH_KEY, "model": FISH_MODEL}
        if character["voice_id"]:
            params["reference_id"] = character["voice_id"]
            headers["Content-Type"] = "application/msgpack"
            payload = msgpack.packb(params, use_bin_type=True)
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
        sync = create_sync(record("generations", ident), audio_file, character)
        change("UPDATE generations SET status='ready', audio_file=?, sync_file=? WHERE id=?",
               (str(audio_file), str(sync), ident))
    except Exception as error:
        change("UPDATE generations SET status='failed', error=? WHERE id=?",
               (str(error)[:500], ident))


def create_sync(job, audio_file: Path, character=None):
    character = character or record("characters", job["character_id"])
    timeline = build_timeline(audio_file, job["text"],
                              character["mouth_intensity"], character["voice_delay"],
                              bool(character["auto_blink"]))
    output = OUTPUTS / (job["id"] + ".sync.json")
    stage = OUTPUTS / (job["id"] + ".sync.tmp")
    stage.write_text(json.dumps(timeline, separators=(",", ":"), ensure_ascii=False), encoding="utf-8")
    stage.replace(output)
    return output

def load_sync(job):
    if not job["audio_file"] or not Path(job["audio_file"]).is_file():
        raise HTTPException(409, "Todavía no hay MP3 para sincronizar.")
    path = Path(job.get("sync_file") or "")
    if not job.get("sync_file") or not path.is_file():
        path = create_sync(job, Path(job["audio_file"]))
        change("UPDATE generations SET sync_file=? WHERE id=?", (str(path), job["id"]))
    return json.loads(path.read_text("utf-8"))

@app.get("/api/generations/{ident}/sync")
def sync_preview(ident: str, _: None = Depends(auth)):
    job = record("generations", ident)
    return load_sync(job)

class SyncSettings(BaseModel):
    mouth_intensity: int = Field(ge=20, le=85)
    voice_delay: int = Field(ge=-100, le=160)
    auto_blink: bool = True

@app.post("/api/generations/{ident}/retime")
def sync_retime(ident: str, settings: SyncSettings, _: None = Depends(auth)):
    job = record("generations", ident)
    if job["status"] == "rendering":
        raise HTTPException(409, "Esperá a que termine el video antes de ajustar.")
    if not job["audio_file"] or not Path(job["audio_file"]).is_file():
        raise HTTPException(409, "Primero se necesita el MP3.")
    change("UPDATE characters SET mouth_intensity=?, voice_delay=?, auto_blink=? WHERE id=?",
           (settings.mouth_intensity, settings.voice_delay, int(settings.auto_blink), job["character_id"]))
    updated_character = record("characters", job["character_id"])
    path = create_sync(job, Path(job["audio_file"]), updated_character)
    if job["video_file"]:
        Path(job["video_file"]).unlink(missing_ok=True)
    if job["webm_file"]:
        Path(job["webm_file"]).unlink(missing_ok=True)
    change("UPDATE generations SET status='ready', video_file='', webm_file='', sync_file=?, error='' WHERE id=?",
           (str(path), ident))
    return {"ok": True, "timeline": json.loads(path.read_text("utf-8"))}

def render_video(ident: str, kind: str = "mp4"):
    """Reuses the same saved audio and phoneme timeline for MP4 and alpha WebM.

    The transparent WebM deliberately ignores the selected background; MP4
    retains the selected background (or the solid fallback).
    """
    if kind not in ("mp4", "webm"):
        raise ValueError("Formato de video no compatible")
    folder = None
    transparent = kind == "webm"
    file_column = "webm_file" if transparent else "video_file"
    try:
        job = record("generations", ident)
        outfit = record("outfits", job["outfit_id"])
        if not job["audio_file"] or not Path(job["audio_file"]).is_file():
            raise RuntimeError("Generá primero el MP3.")
        missing = [SLOTS[i] for i in range(8) if not (outfit_dir(outfit) / f"{i:02d}.png").is_file()]
        if missing:
            raise RuntimeError("Faltan imágenes para exportar: " + ", ".join(missing))
        change("UPDATE generations SET status=?, error='' WHERE id=?",
               ("rendering_webm" if transparent else "rendering", ident))
        plan = load_sync(job)
        folder = Path(tempfile.mkdtemp(prefix=f"render_{kind}_", dir=TEMP))
        width, height = 720, 1280
        if transparent:
            # Keep RGBA all the way from the original PNG to the VP9 alpha encoder.
            # Never blend the selected background into a transparent export.
            base = Image.new("RGBA", (width, height), (0, 0, 0, 0))
        elif job["background_id"]:
            bg = record("backgrounds", job["background_id"])
            with Image.open(bg["file"]) as im:
                base = ImageOps.fit(im.convert("RGB"), (width, height),
                                    method=Image.Resampling.LANCZOS).convert("RGBA")
        else:
            base = Image.new("RGBA", (width, height), "#131722")

        outfit_folder = outfit_dir(outfit)
        for index in range(8):
            with Image.open(outfit_folder / f"{index:02d}.png") as source:
                sprite = source.convert("RGBA")
                sprite.thumbnail((width, height), Image.Resampling.LANCZOS)
            composed = base.copy()
            composed.alpha_composite(sprite, ((width - sprite.width) // 2, height - sprite.height))
            # FFmpeg's VP9 alpha support relies on the frame still being RGBA here.
            composed.save(folder / f"frame_{index}.png", optimize=False) if transparent else (
                composed.convert("RGB").save(folder / f"frame_{index}.png", optimize=False)
            )
        lines = ["ffconcat version 1.0"]
        for pose, duration in event_durations(plan):
            frame_path = (folder / f"frame_{pose}.png").as_posix()
            lines += [f"file '{frame_path}'", f"duration {duration:.6f}"]
        last_pose = plan["events"][-1][1]
        lines.append(f"file '{(folder / f'frame_{last_pose}.png').as_posix()}'")
        seq = folder / "timeline.ffconcat"
        seq.write_text("\n".join(lines) + "\n", encoding="utf-8")
        output = OUTPUTS / (ident + f".{kind}")
        stage = OUTPUTS / (ident + f".pending.{kind}")
        base_command = [
            "ffmpeg", "-nostdin", "-hide_banner", "-loglevel", "error", "-y",
            "-f", "concat", "-safe", "0", "-i", str(seq),
            "-i", job["audio_file"], "-map", "0:v:0", "-map", "1:a:0",
        ]
        if transparent:
            # libvpx-vp9 with yuva420p + disabled alt-ref preserves PNG alpha.
            # libopus ensures the speaking voice is included in WebM.
            encode = [
                "-vf", "fps=25,format=yuva420p",
                "-c:v", "libvpx-vp9", "-pix_fmt", "yuva420p",
                "-auto-alt-ref", "0", "-deadline", "good", "-cpu-used", "5",
                "-crf", "33", "-b:v", "0", "-threads", "2", "-row-mt", "1",
                "-c:a", "libopus", "-b:a", "128k", "-metadata:s:v:0", "alpha_mode=1",
            ]
        else:
            encode = [
                "-vf", "fps=25,format=yuv420p",
                "-c:v", "libx264", "-preset", "veryfast", "-crf", "23",
                "-threads", "2", "-c:a", "aac", "-b:a", "160k",
                "-movflags", "+faststart",
            ]
        process = subprocess.run(base_command + encode +
            ["-t", f"{plan['duration']:.5f}", str(stage)],
            capture_output=True, text=True, timeout=900 if transparent else 600)
        if process.returncode or not stage.exists() or stage.stat().st_size < 1000:
            raise RuntimeError("FFmpeg: " + process.stderr[-450:])
        stage.replace(output)
        change(f"UPDATE generations SET status='ready', {file_column}=? WHERE id=?",
               (str(output), ident))
    except Exception as error:
        change("UPDATE generations SET status=?, error=? WHERE id=?",
               ("webm_failed" if transparent else "video_failed", str(error)[:500], ident))
    finally:
        if folder:
            shutil.rmtree(folder, ignore_errors=True)

export_lock = threading.Lock()

def queue_video(ident: str, kind: str):
    # Lock serializes check + status transition to avoid duplicate concurrent jobs.
    with export_lock:
        job = record("generations", ident)
        file_column = "webm_file" if kind == "webm" else "video_file"
        filename = job[file_column]
        if filename and Path(filename).is_file():
            return {"ok": True, "status": "ready"}
        if job["status"] in ("rendering", "rendering_webm"):
            if job["status"] == ("rendering_webm" if kind == "webm" else "rendering"):
                return {"ok": True, "status": job["status"]}
            raise HTTPException(409, "Ya se está preparando otro formato. Esperá a que termine.")
        if not job["audio_file"] or not Path(job["audio_file"]).is_file():
            raise HTTPException(409, "Primero esperá a que termine el MP3.")
        outfit = record("outfits", job["outfit_id"])
        if not all((outfit_dir(outfit) / f"{i:02d}.png").is_file() for i in range(8)):
            raise HTTPException(400, "Completá los ocho PNG antes de exportar video.")
        status = "rendering_webm" if kind == "webm" else "rendering"
        change("UPDATE generations SET status=?, error='' WHERE id=?", (status, ident))
        executor.submit(render_video, ident, kind)
        return {"ok": True, "status": status}

@app.post("/api/generations/{ident}/video")
def video_start(ident: str, _: None = Depends(auth)):
    return queue_video(ident, "mp4")

@app.post("/api/generations/{ident}/webm")
def webm_start(ident: str, _: None = Depends(auth)):
    return queue_video(ident, "webm")

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
    if kind not in ("mp3", "mp4", "webm"):
        raise HTTPException(404, "Formato desconocido.")
    filename = {"mp3":job["audio_file"], "mp4":job["video_file"], "webm":job["webm_file"]}[kind]
    if not filename:
        raise HTTPException(404, "Archivo todavía no disponible.")
    path = Path(filename)
    if not path.is_file():
        raise HTTPException(404, "Archivo todavía no disponible.")
    return FileResponse(path, media_type={"mp3":"audio/mpeg", "mp4":"video/mp4", "webm":"video/webm"}[kind],
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
