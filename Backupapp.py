import eventlet
eventlet.monkey_patch()  # Parchea eventlet antes de cualquier otro módulo
from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO, emit
from flask_cors import CORS
import os
import json
import datetime
import base64
import speech_recognition as sr
from pydub import AudioSegment
import io
import re  # Para expresiones regulares

app = Flask(__name__, static_folder='static')
CORS(app)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='eventlet')

# Archivo para guardar el historial
HISTORY_FILE = os.path.join(os.getcwd(), "history.json")

# Lista de matrículas aeronáuticas argentinas (se puede ampliar con una fuente confiable)
MATRICULAS = [
    "LV-ABC", "LV-XYZ", "LQA-123",  # Ejemplo inicial
]

# Expresión regular para detectar matrículas aeronáuticas
MATRICULA_REGEX = re.compile(r"LV-[A-Z]{3}|LQ[A-Z]-\d{3}")

def load_history():
    """Carga el historial desde un archivo JSON."""
    if os.path.exists(HISTORY_FILE):
        with open(HISTORY_FILE, "r") as file:
            return json.load(file)
    return {}

def save_history(history):
    """Guarda el historial en un archivo JSON."""
    with open(HISTORY_FILE, "w") as file:
        json.dump(history, file, indent=4)

history = load_history()

def transcribe_audio(audio_data):
    """Transcribe el audio en texto y detecta matrículas aeronáuticas."""
    try:
        recognizer = sr.Recognizer()
        audio_content = base64.b64decode(audio_data.split(",")[-1])
        audio = AudioSegment.from_file(io.BytesIO(audio_content), format="wav")
        audio.export("temp.wav", format="wav")
        with sr.AudioFile("temp.wav") as source:
            audio_data = recognizer.record(source)
        text = recognizer.recognize_google(audio_data, language="es-AR")  # Español argentino
        
        # Detectar matrículas aeronáuticas usando regex
        matches = MATRICULA_REGEX.findall(text.upper())
        for match in matches:
            text = text.replace(match, f"**{match}**")
        
        return text
    except sr.UnknownValueError:
        return "No se pudo reconocer el audio"
    except sr.RequestError:
        return "Error en la conexión al servicio de reconocimiento"
    finally:
        if os.path.exists("temp.wav"):
            os.remove("temp.wav")

@app.route('/')
def index():
    """Renderiza la página principal con el historial del día."""
    today = datetime.date.today().isoformat()
    today_messages = history.get(today, [])
    return render_template('index.html', today_messages=today_messages, history=history)

@app.route('/history/<date>')
def get_history(date):
    """Retorna los mensajes del historial para una fecha específica."""
    messages = history.get(date, [])
    return jsonify(messages)

@socketio.on('start_audio')
def handle_start_audio():
    """Notifica a todos los clientes que el audio ha comenzado."""
    emit('audio_stream_start', broadcast=True, include_self=False)

@socketio.on('audio_chunk')
def handle_audio_chunk(data):
    """Recibe fragmentos de audio y los retransmite a otros clientes."""
    audio_data = data.get("audio")
    if audio_data:
        emit('audio_chunk', {"audio": audio_data}, broadcast=True, include_self=False)

@socketio.on('stop_audio')
def handle_stop_audio(data):
    """Detiene el audio, transcribe y guarda el mensaje en el historial."""
    date_key = datetime.date.today().isoformat()
    display_time = datetime.datetime.now().strftime('%H:%M')
    audio_data = data.get("audio")
    
    if not audio_data or "," not in audio_data:
        print("Error: Datos de audio inválidos o vacíos")
        return

    text = transcribe_audio(audio_data) if audio_data else "Sin transcripción"

    if date_key not in history:
        history[date_key] = []
    
    history[date_key].append({"audio": audio_data, "text": text, "timestamp": display_time})
    save_history(history)
    emit('audio_stopped', {"audio": audio_data, "text": text, "timestamp": display_time}, broadcast=True)

if __name__ == '__main__':
    port = int(os.environ.get("PORT", 5000))  # Puerto por defecto para Render
    socketio.run(app, host="0.0.0.0", port=port, debug=True)
  
