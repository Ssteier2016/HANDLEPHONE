import eventlet
eventlet.monkey_patch()  # Parchea eventlet antes de cualquier otro módulo
from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO, emit
from flask_cors import CORS
import os
import json
import datetime
import base64
import speech_recognition as sr  # SpeechRecognition para transcripción de audio

app = Flask(__name__)
CORS(app)
socketio = SocketIO(app, cors_allowed_origins="*", async_mode='eventlet')  # Usar Eventlet como motor

HISTORY_FILE = os.path.join(os.getcwd(), "history.json")

def load_history():
    if os.path.exists(HISTORY_FILE):
        with open(HISTORY_FILE, "r") as file:
            return json.load(file)
    return {}

def save_history(history):
    with open(HISTORY_FILE, "w") as file:
        json.dump(history, file, indent=4)

history = load_history()

def transcribe_audio(audio_data):
    try:
        recognizer = sr.Recognizer()
        audio_content = base64.b64decode(audio_data.split(",")[-1])  # Extraer datos base64
        audio_file = sr.AudioData(audio_content, 16000, 2)  # Frecuencia de muestreo y tipo de audio
        text = recognizer.recognize_google(audio_file)  # Usa Google para mejor precisión
        return text
    except sr.UnknownValueError:
        return "No se pudo reconocer el audio"
    except sr.RequestError:
        return "Error en la conexión al servicio de reconocimiento"

@app.route('/')
def index():
    today = datetime.date.today().isoformat()
    today_messages = history.get(today, [])
    return render_template('index.html', today_messages=today_messages, history=history)

@app.route('/talk', methods=['POST'])
def talk():
    message = request.form.get('message', 'Hablando...')
    date_key = datetime.date.today().isoformat()
    timestamp = datetime.datetime.now().strftime('%H:%M')
    
    if date_key not in history:
        history[date_key] = []
    
    history[date_key].append({"text": message, "timestamp": timestamp})
    save_history(history)
    
    socketio.emit('new_message', {"text": message, "timestamp": timestamp}, broadcast=True)
    return jsonify({'status': 'success', 'message': message})

@socketio.on('start_audio')
def handle_start_audio():
    emit('audio_stream_start', broadcast=True, include_self=False)

@socketio.on('audio_chunk')
def handle_audio_chunk(data):
    audio_data = data.get("audio")
    emit('audio_chunk', {"audio": audio_data}, broadcast=True, include_self=False)

@socketio.on('stop_audio')
def handle_stop_audio(data):
    date_key = datetime.date.today().isoformat()
    display_time = datetime.datetime.now().strftime('%H:%M')
    audio_data = data.get("audio")
    text = transcribe_audio(audio_data) if audio_data else data.get("text", "Sin transcripción")

    if not audio_data or "," not in audio_data:
        print("Error: Datos de audio inválidos o vacíos")
        return

    if date_key not in history:
        history[date_key] = []
    
    history[date_key].append({"audio": audio_data, "text": text, "timestamp": display_time})
    save_history(history)
    emit('audio_stopped', {"audio": audio_data, "text": text, "timestamp": display_time}, broadcast=True)

if __name__ == '__main__':
    port = int(os.environ.get("PORT", 8080))  # Usa el puerto de Render o 8080 por defecto
    host = '0.0.0.0'
    socketio.run(app, host=host, port=port, debug=True, use_reloader=False)
