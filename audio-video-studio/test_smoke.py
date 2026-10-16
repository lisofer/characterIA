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

if __name__=="__main__":
    unittest.main(verbosity=2)
