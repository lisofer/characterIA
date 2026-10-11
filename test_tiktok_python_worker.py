"""Pruebas del formato mínimo que Python envía al panel Node."""
import importlib.util
import pathlib
import unittest
from types import SimpleNamespace

MODULE = pathlib.Path(__file__).with_name("tiktok-python-worker.py")
spec = importlib.util.spec_from_file_location("tiktok_worker", MODULE)
# Cargar desde un archivo con guiones también funciona con el nombre de módulo fijo.
worker = importlib.util.module_from_spec(spec)
spec.loader.exec_module(worker)


def event(*, name="Rose", count=1, streakable=False, streaking=False):
    gift = SimpleNamespace(id=5655, name=name, streakable=streakable)
    user = SimpleNamespace(unique_id="juanma", nickname="Juanma")
    return SimpleNamespace(gift=gift, user=user, repeat_count=count,
                           streaking=streaking, msg_id="abc")


class GiftWorkerTest(unittest.TestCase):
    def test_single_rose(self):
        result = worker.normalize_gift(event())
        self.assertEqual(result["giftName"], "Rose")
        self.assertEqual(result["giftId"], "5655")
        self.assertEqual(result["user"]["username"], "juanma")
        self.assertEqual(result["user"]["name"], "Juanma")
        self.assertEqual(result["count"], 1)

    def test_streak_waits_until_finished(self):
        self.assertIsNone(worker.normalize_gift(event(count=2, streakable=True,
                                                       streaking=True)))
        self.assertEqual(worker.normalize_gift(
            event(count=5, streakable=True, streaking=False))["count"], 5)

    def test_missing_gift(self):
        self.assertIsNone(worker.normalize_gift(SimpleNamespace(gift=None)))

    def test_invalid_count(self):
        e = event()
        e.repeat_count = "invalid"
        self.assertEqual(worker.normalize_gift(e)["count"], 1)


if __name__ == "__main__":
    unittest.main()
