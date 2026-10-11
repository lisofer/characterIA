"""Lector TikTokLive de regalos para Persona Studio (stdout: NDJSON).
Se ejecuta solo al conectar el chat. No necesita otro servicio ni API propia.
TikTokLive usa una firma externa gratuita con límites; puede no conectar.
"""
import asyncio
import json
import sys
import time


def emit(kind, **data):
    print(json.dumps({"type": kind, **data}, ensure_ascii=False, separators=(",", ":")), flush=True)


def safe_text(value, limit=100):
    return str(value or "").strip()[:limit]


def normalize_gift(event):
    gift = getattr(event, "gift", None)
    if gift is None:
        return None
    if bool(getattr(gift, "streakable", False)) and bool(getattr(event, "streaking", False)):
        return None  # No anunciar a mitad de una racha.
    user = getattr(event, "user", None)
    gift_id = safe_text(getattr(gift, "id", None) or getattr(gift, "gift_id", None), 45)
    name = safe_text(getattr(gift, "name", None), 90)
    if not name:
        name = "Rosa" if gift_id == "5655" else f"Regalo #{gift_id or 'desconocido'}"
    count = getattr(event, "repeat_count", 1)
    try:
        count = max(1, min(100000, int(count or 1)))
    except (TypeError, ValueError, OverflowError):
        count = 1
    return {
        "giftId": gift_id,
        "giftName": name,
        "count": count,
        "user": {
            "username": safe_text(getattr(user, "unique_id", None) or getattr(user, "display_id", None), 40),
            "name": safe_text(getattr(user, "nickname", None) or getattr(user, "unique_id", None), 50),
        },
        "messageId": safe_text(getattr(event, "msg_id", None) or getattr(event, "message_id", None), 100),
        "at": int(time.time() * 1000),
    }


async def main():
    username = (sys.argv[1] if len(sys.argv) > 1 else "").lstrip("@").strip()
    if not username or len(username) > 30:
        emit("error", message="Ingresá un @usuario válido.")
        return
    try:
        from TikTokLive import TikTokLiveClient
        from TikTokLive.events import ConnectEvent, GiftEvent, DisconnectEvent
    except Exception as exc:
        emit("error", message="No se pudo cargar TikTokLive Python: " + safe_text(exc, 170))
        return

    client = TikTokLiveClient(unique_id="@" + username)

    @client.on(ConnectEvent)
    async def on_connect(event):
        emit("connected", roomId=safe_text(getattr(event, "room_id", None) or getattr(client, "room_id", None), 80))

    @client.on(GiftEvent)
    async def on_gift(event):
        try:
            item = normalize_gift(event)
            if item:
                emit("gift", **item)
        except Exception as exc:
            print("TikTokLive gift decode: " + safe_text(exc, 180), file=sys.stderr, flush=True)

    @client.on(DisconnectEvent)
    async def on_disconnect(_):
        emit("disconnected")

    try:
        await client.connect()
    except asyncio.CancelledError:
        raise
    except Exception as exc:
        emit("error", message=safe_text(exc, 210) or exc.__class__.__name__)


if __name__ == "__main__":
    try:
        asyncio.run(main())
    except KeyboardInterrupt:
        pass
