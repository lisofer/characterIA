import io
import os
import tempfile
import subprocess
import time
import unittest
from pathlib import Path
from PIL import Image
from fastapi.testclient import TestClient

tmp = tempfile.TemporaryDirectory(prefix="persona_studio_test_")
os.environ["DATA_DIR"] = tmp.name
os.environ["APP_PASSWORD"] = "local-test-password"
os.environ["SESSION_SECRET"] = "local-test-secret-that-is-long"
os.environ.pop("FISH_API_KEY", None)
import main

def picture_bytes(color, mode="RGBA", fmt="PNG"):
    image = Image.new(mode, (120, 200), color)
    output = io.BytesIO()
    image.save(output, format=fmt)
    return output.getvalue()

class StudioSmokeTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.client = TestClient(main.app)
        cls.client.post("/api/login", json={"password": "local-test-password"})

    def test_full_storage_and_video(self):
        # The mobile create view must not show the old test panel or the last-generation card.
        homepage=self.client.get("/")
        self.assertEqual(homepage.status_code,200)
        ui=homepage.text
        self.assertIn('id="character-choice"',ui)
        self.assertIn('id="outfit-choice"',ui)
        self.assertIn('id="background-choice"',ui)
        self.assertIn('id="preview-scene"',ui)
        self.assertIn('id="download-mp3"',ui)
        self.assertIn('id="download-mp4"',ui)
        self.assertIn('id="download-webm"',ui)
        self.assertIn('data-shape="fit"',ui)
        self.assertIn('data-shape="square"',ui)
        self.assertIn('data-shape="circle"',ui)
        self.assertIn('id="square-vertical"',ui)
        self.assertIn('id="circle-size"',ui)
        self.assertNotIn('id="current-result"',ui)
        self.assertNotIn('id="test-speak"',ui)
        script=self.client.get("/mobile-player.js")
        self.assertEqual(script.status_code,200)
        self.assertIn('function unlockAudio()',script.text)
        self.assertIn('function syncFrame()',script.text)
        unauth = TestClient(main.app)
        self.assertEqual(unauth.get("/api/state").status_code, 401)
        self.assertEqual(unauth.post("/api/login", json={"password": "bad"}).status_code, 401)
        char = self.client.post("/api/characters", data={
            "name": "Prueba", "voice_id": "demo-fish-voice-id", "notes": "divertido"
        })
        self.assertEqual(char.status_code, 200, char.text)
        cid = char.json()["id"]
        invalid = self.client.post("/api/characters/" + cid + "/outfits",
                                   data={"name":"faltan"},
                                   files=[("images", ("00.png", picture_bytes("red"), "image/png"))])
        self.assertEqual(invalid.status_code, 400, invalid.text)
        empty = self.client.post("/api/characters/" + cid + "/outfits",data={"name":"Otro traje"})
        self.assertEqual(empty.status_code,200,empty.text)
        eid=empty.json()["id"]
        self.assertEqual(self.client.get("/api/outfits/"+eid+"/image/1").status_code,404)
        partial = self.client.post("/api/outfits/"+eid+"/slot/1",
              files={"image":("01.png",picture_bytes("red"),"image/png")})
        self.assertEqual(partial.status_code,200,partial.text)
        state_after = self.client.get("/api/state").json()
        saved = next(x for x in state_after["outfits"] if x["id"]==eid)
        self.assertTrue(saved["slots"][1])
        self.assertFalse(saved["complete"])
        self.assertEqual(self.client.get("/api/outfits/"+eid+"/image/1").status_code,200)
        items = [("images", (f"{i:02d}.png", picture_bytes((i*23, 70, 130, 255)), "image/png")) for i in range(8)]
        outfit = self.client.post("/api/characters/" + cid + "/outfits",
                                  data={"name":"Remera test"}, files=items)
        self.assertEqual(outfit.status_code, 200, outfit.text)
        sid = outfit.json()["id"]
        bg = self.client.post("/api/backgrounds",
                              data={"name":"Fondo test"},
                              files={"image":("bg.png", picture_bytes("#335577", "RGB"), "image/png")})
        self.assertEqual(bg.status_code, 200, bg.text)
        bid = bg.json()["id"]
        self.assertEqual(self.client.get("/api/outfits/"+sid+"/image/0").status_code,200)
        self.assertEqual(self.client.get("/api/backgrounds/"+bid+"/image").status_code,200)
        state = self.client.get("/api/state").json()
        self.assertEqual(len(state["characters"]), 1)
        self.assertEqual(len(state["outfits"]), 2)
        self.assertEqual(len(state["backgrounds"]), 1)
        self.assertEqual(self.client.post("/api/generations", json={
            "character_id":cid, "outfit_id":sid,"background_id":bid,"text":"Hola"
        }).status_code, 503) # Fish key deliberately absent

        ident=main.new_id()
        audio=main.OUTPUTS/(ident+".mp3")
        proc=subprocess.run(["ffmpeg","-hide_banner","-loglevel","error","-y",
                             "-f","lavfi","-i","sine=frequency=420:duration=1.3",
                             "-codec:a","libmp3lame",str(audio)],capture_output=True,timeout=30)
        self.assertEqual(proc.returncode,0,proc.stderr.decode(errors="replace"))
        main.change("INSERT INTO generations (id,character_id,outfit_id,background_id,text,status,error,audio_file,video_file,created_at) VALUES (?,?,?,?,?,?,?,?,?,?)",
                    (ident,cid,sid,bid,"Guion de prueba","ready","",str(audio),"",time.time()))
        start=self.client.post("/api/generations/"+ident+"/video")
        self.assertEqual(start.status_code,200,start.text)
        deadline=time.time()+75
        final=None
        while time.time()<deadline:
            final=main.record("generations",ident)
            if final["status"] in ("ready","video_failed"):break
            time.sleep(.5)
        self.assertIsNotNone(final)
        self.assertEqual(final["status"],"ready", final["error"])
        self.assertTrue(Path(final["video_file"]).stat().st_size>2000)
        self.assertEqual(self.client.get("/api/generations/"+ident+"/file/mp3?download=1").status_code,200)
        sync=self.client.get("/api/generations/"+ident+"/sync")
        self.assertEqual(sync.status_code,200,sync.text)
        timeline=sync.json()
        self.assertEqual(timeline["slot_names"],["aClosed","aOpen","idleClosed","idleOpen","oClosed","oOpen","eClosed","eOpen"])
        self.assertTrue(timeline["events"])
        self.assertEqual(timeline["intensity"],45)
        adjusted=self.client.post("/api/generations/"+ident+"/retime",json={
            "mouth_intensity":20,"voice_delay":60,"auto_blink":False
        })
        self.assertEqual(adjusted.status_code,200,adjusted.text)
        self.assertEqual(adjusted.json()["timeline"]["delay_ms"],60)
        self.assertEqual(adjusted.json()["timeline"]["intensity"],20)
        self.assertFalse(adjusted.json()["timeline"]["auto_blink"])
        self.assertEqual(main.record("characters",cid)["mouth_intensity"],20)
        self.assertFalse(main.record("generations",ident)["video_file"])
        second=self.client.post("/api/generations/"+ident+"/video")
        self.assertEqual(second.status_code,200,second.text)
        until=time.time()+75
        while time.time()<until and main.record("generations",ident)["status"]=="rendering":
            time.sleep(.4)
        self.assertEqual(main.record("generations",ident)["status"],"ready",main.record("generations",ident)["error"])
        self.assertEqual(self.client.get("/api/generations/"+ident+"/file/mp4?download=1").status_code,200)
        # WEBM must preserve actual transparent alpha even when an MP4 background is selected.
        transparent=self.client.post("/api/generations/"+ident+"/webm")
        self.assertEqual(transparent.status_code,200,transparent.text)
        until=time.time()+140
        while time.time()<until and main.record("generations",ident)["status"]=="rendering_webm":
            time.sleep(.4)
        webm_job=main.record("generations",ident)
        self.assertEqual(webm_job["status"],"ready",webm_job["error"])
        self.assertTrue(Path(webm_job["webm_file"]).is_file())
        result=self.client.get("/api/generations/"+ident+"/file/webm?download=1")
        self.assertEqual(result.status_code,200,result.text[:300] if result.status_code!=200 else "")
        self.assertIn("video/webm",result.headers["content-type"])
        probe=subprocess.run(
            ["ffprobe","-v","error","-show_entries","stream=codec_name:stream_tags=alpha_mode",
             "-of","json",webm_job["webm_file"]],capture_output=True,text=True,check=True,timeout=25)
        info=__import__("json").loads(probe.stdout)
        self.assertTrue(any(s.get("codec_name")=="opus" for s in info["streams"]))
        self.assertTrue(any(s.get("codec_name")=="vp9" and
            s.get("tags",{}).get("ALPHA_MODE")=="1" for s in info["streams"]),info)
        # Explicit libvpx decoder is needed to actually expose VP9 alpha.
        first=subprocess.run(
            ["ffmpeg","-v","error","-c:v","libvpx-vp9","-i",webm_job["webm_file"],
             "-frames:v","1","-pix_fmt","rgba","-f","rawvideo","pipe:1"],
            capture_output=True,check=True,timeout=35)
        self.assertGreaterEqual(len(first.stdout),720*1280*4)
        self.assertEqual(first.stdout[3],0,"The WebM upper-left corner must be transparent.")
        center_bottom=((1280-100)*720+360)*4+3
        self.assertEqual(first.stdout[center_bottom],255,
                         "The character body must remain opaque over transparent canvas.")
        self.assertTrue(Path(main.record("generations",ident)["video_file"]).is_file(),
                        "Generating WebM must not delete the already rendered MP4.")
        # Switching shape never re-synthesizes Fish and leaves the WebM untouched.
        original_webm=main.record("generations",ident)["webm_file"]
        first_square=self.client.post("/api/generations/"+ident+"/framing",
            json={"shape":"square","vertical":-70,"circle_size":100})
        self.assertEqual(first_square.status_code,200,first_square.text)
        self.assertTrue(first_square.json()["changed"])
        job=main.record("generations",ident)
        self.assertEqual(job["mp4_shape"],"square")
        self.assertEqual(job["mp4_vertical"],-70)
        self.assertFalse(job["video_file"])
        self.assertEqual(job["webm_file"],original_webm)
        self.assertEqual(self.client.get("/api/generations/"+ident+"/file/webm").status_code,200)
        sq_img=main._export_canvas(job,main.record("outfits",sid),False,0)
        self.assertEqual(sq_img.size,(1080,1080))
        self.assertEqual(sq_img.mode,"RGB")
        self.assertEqual(self.client.post("/api/generations/"+ident+"/framing",
            json={"shape":"bad","vertical":0,"circle_size":100}).status_code,422)
        first_round=self.client.post("/api/generations/"+ident+"/framing",
            json={"shape":"circle","vertical":0,"circle_size":75})
        self.assertEqual(first_round.status_code,200,first_round.text)
        job=main.record("generations",ident)
        self.assertEqual(job["mp4_shape"],"circle")
        masked=main._export_canvas(job,main.record("outfits",sid),False,0)
        self.assertEqual(masked.size,(1080,1080))
        self.assertEqual(masked.getpixel((0,0)),(19,23,34))
        self.assertNotEqual(masked.getpixel((540,540)),(19,23,34))
        # The final MP4 is truly encoded at 1080x1080 for a circular frame.
        start=self.client.post("/api/generations/"+ident+"/video")
        self.assertEqual(start.status_code,200,start.text)
        until=time.time()+90
        while time.time()<until and main.record("generations",ident)["status"]=="rendering":
            time.sleep(.4)
        circle_job=main.record("generations",ident)
        self.assertEqual(circle_job["status"],"ready",circle_job["error"])
        resolution=subprocess.run(
            ["ffprobe","-v","error","-select_streams","v:0","-show_entries",
             "stream=width,height","-of","csv=s=x:p=0",circle_job["video_file"]],
            capture_output=True,text=True,check=True,timeout=25)
        self.assertEqual(resolution.stdout.strip(),"1080x1080")
        self.assertTrue(Path(circle_job["webm_file"]).is_file())
        # Retiming must invalidate both videos but keep the Fish MP3.
        settings={"mouth_intensity":65,"voice_delay":-20,"auto_blink":True}
        recal=self.client.post("/api/generations/"+ident+"/retime",json=settings)
        self.assertEqual(recal.status_code,200,recal.text)
        updated=main.record("generations",ident)
        self.assertFalse(updated["video_file"])
        self.assertFalse(updated["webm_file"])
        self.assertTrue(Path(updated["audio_file"]).is_file())




if __name__=="__main__":
    unittest.main(verbosity=2)
