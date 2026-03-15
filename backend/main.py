from fastapi import FastAPI, UploadFile, File, Form
from fastapi.middleware.cors import CORSMiddleware
import shutil
import uuid
import os
from pathlib import Path
from whisper_service import transcribe_audio

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.get("/")
def root():
    return {"status": "server running"}

@app.post("/transcribe")
async def transcribe(
    file: UploadFile = File(...),
    language: str = Form("auto"),  # "zh" | "en" | "auto"
):
    file_id = str(uuid.uuid4())
    suffix = Path(file.filename).suffix or ".webm"
    file_path = f"temp_{file_id}{suffix}"

    try:
        with open(file_path, "wb") as buffer:
            shutil.copyfileobj(file.file, buffer)

        text = transcribe_audio(file_path, language=language)
        return {"text": text}
    finally:
        try:
            if os.path.exists(file_path):
                os.remove(file_path)
        except Exception:
            pass