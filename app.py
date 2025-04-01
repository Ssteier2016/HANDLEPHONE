from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO, emit
from flask_cors import CORS
import os
import json
import datetime
import base64

app = Flask(__name__)
CORS(app)
socketio = SocketIO(app, cors_allowed_origins="*")

HISTORY_FILE = os.path.join(os.getcwd(), "history.json")
AUDIO_FOLDER = os.path.join(os.getcwd(), "audio_messages")
os.makedirs(AUDIO_FOLDER, exist_ok=True)

def load_history():
    if os.path.exists(HISTORY_FILE):
        with open(HISTORY_FILE, "r") as file:
            return json.load(file)
    return {}

def save_history(history):
    with open(HISTORY_FILE, "w") as file:
        json.dump(history, file, indent=4)

history = load_history()

@app.route('/')
def index():
    today = datetime.date.today().isoformat()
    today_messages = history.get(today, [])
    return render_template('index.html', today_messages=today_messages, history=history)

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
    timestamp = datetime.datetime.now().strftime('%H-%M')
    display_time = datetime.datetime.now().strftime('%H:%M')
    filename = os.path.join(AUDIO_FOLDER, f"{date_key}_{timestamp}.webm")
    
    audio_data = data.get("audio")
    text = data.get("text", "Sin transcripción")
    
    if audio_data and "," in audio_data:
        try:
            audio_content = audio_data.split(",")[-1]
            decoded_audio = base64.b64decode(audio_content)
            with open(filename, "wb") as audio_file:
                audio_file.write(decoded_audio)
            print(f"Archivo guardado: {filename}")
        except Exception as e:
            print(f"Error al guardar el archivo: {e}")
            return
    
    if date_key not in history:
        history[date_key] = []
    history[date_key].append({"audio": filename, "text": text, "timestamp": display_time})
    save_history(history)
    emit('audio_stopped', {"audio": filename, "text": text, "timestamp": display_time}, broadcast=True)

if __name__ == '__main__':
    socketio.run(app, host='0.0.0.0', port=8080, debug=True, use_reloader=False)