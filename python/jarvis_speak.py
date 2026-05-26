"""
JARVIS voice synthesizer — ARC Reactor
Uses the jgkawell/jarvis Piper ONNX model (trained on Paul Bettany's MCU JARVIS voice).
Caches generated WAV so repeated phrases play instantly.

Installation:
  pip install piper-tts

Model files (~/.claude/jarvis-piper/):
  jarvis-medium.onnx
  jarvis-medium.onnx.json

Download from: https://github.com/jgkawell/jarvis (releases page)
"""
import sys
import os
import hashlib
import wave
import platform

MODEL_DIR   = os.path.join(os.path.expanduser("~"), ".claude", "jarvis-piper")
MODEL_PATH  = os.path.join(MODEL_DIR, "jarvis-medium.onnx")
CONFIG_PATH = os.path.join(MODEL_DIR, "jarvis-medium.onnx.json")
CACHE_DIR   = os.path.join(os.path.expanduser("~"), ".claude", "jarvis-audio", "cache")
VOICE_KEY   = "jarvis-medium"


def get_cache_path(text: str) -> str:
    key = hashlib.md5(f"{VOICE_KEY}:{text}".encode()).hexdigest()
    return os.path.join(CACHE_DIR, f"{key}.wav")


def ensure_audio(text: str) -> str:
    os.makedirs(CACHE_DIR, exist_ok=True)
    path = get_cache_path(text)
    if not os.path.exists(path):
        from piper import PiperVoice
        voice = PiperVoice.load(MODEL_PATH, config_path=CONFIG_PATH)
        with wave.open(path, "wb") as wf:
            voice.synthesize_wav(text, wf)
    return path


def play_wav(path: str):
    system = platform.system()
    if system == "Windows":
        import winsound
        winsound.PlaySound(path, winsound.SND_FILENAME)
    elif system == "Darwin":
        os.system(f'afplay "{path}"')
    else:
        # Linux — try aplay, then paplay, then ffplay
        for player in ["aplay", "paplay", "ffplay -nodisp -autoexit"]:
            if os.system(f'{player} "{path}" 2>/dev/null') == 0:
                break


if __name__ == "__main__":
    args = sys.argv[1:]
    no_play   = "--no-play"   in args
    path_only = "--path-only" in args
    args = [a for a in args if a not in ("--no-play", "--path-only")]
    text = " ".join(args) if args else "System ready."
    audio_path = ensure_audio(text)
    if path_only:
        print(audio_path, flush=True)
    elif not no_play:
        play_wav(audio_path)
