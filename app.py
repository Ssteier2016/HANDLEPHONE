import eventlet
eventlet.monkey_patch()  # Parchea eventlet antes de cualquier otro módulo
from flask import Flask, render_template, request, jsonify
from flask_socketio import SocketIO, emit
from flask_cors import CORS
import os
import json
import datetime
import base64
from google.cloud import speech_v1p1beta1 as speech  # Integración con Google Speech-to-Text

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
        client = speech.SpeechClient()
        audio_content = base64.b64decode(audio_data.split(",")[-1])  # Extraer datos base64
        audio = speech.RecognitionAudio(content=audio_content)
        config = speech.RecognitionConfig(
            encoding=speech.RecognitionConfig.AudioEncoding.WEBM_OPUS,
            sample_rate_hertz=16000,
            language_code="es-ES",
        )
        response = client.recognize(config=config, audio=audio)
        return " ".join(result.alternatives[0].transcript for result in response.results)
    except Exception as e:
        print(f"Error en la transcripción: {e}")
        return "Error en la transcripción"

@app.route('/')
def index():
    with app.app_context():  # Contexto de la aplicación
        today = datetime.date.today().isoformat()
        today_messages = history.get(today, [])
        return render_template('index.html', today_messages=today_messages, history=history)

@app.route('/talk', methods=['POST'])
def talk():
    with app.app_context():  # Contexto de la aplicación
        message = request.form.get('message', 'Hablando...')
        date_key = datetime.date.today().isoformat()
        display_time = datetime.datetime.now().strftime('%H:%M')
        if date_key not in history:
            history[date_key] = []
        history[date_key].append({"text": message, "timestamp": display_time})
        save_history(history)
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
    display_time = datetime.datetime.now().strftime('%H:%M')  # Sin segundos
    audio_data = data.get("audio")
    text = transcribe_audio(audio_data) if audio_data else data.get("text", "Sin transcripción")

    if not audio_data or "," not in audio_data:
        print("Error: Datos de audio inválidos o vacíos")
        return

    # Guardamos el audio en base64 directamente en el historial
    audio_content = audio_data  # String base64 completo (data:audio/webm;base64,...)

    if date_key not in history:
        history[date_key] = []
    history[date_key].append({"audio": audio_content, "text": text, "timestamp": display_time})
    save_history(history)
    emit('audio_stopped', {"audio": audio_content, "text": text, "timestamp": display_time}, broadcast=True)

if __name__ == '__main__':
    # Configuración dinámica para local y Render
    port = int(os.environ.get("PORT", 8080))  # Usa el puerto de Render o 8080 por defecto
    host = '0.0.0.0'  # Accesible desde cualquier interfaz

    # Verificar si existen certificados para SSL en local
    use_ssl = os.path.exists('key.pem') and os.path.exists('cert.pem')
    if use_ssl:
        ssl_args = {
            'keyfile': 'key.pem',
            'certfile': 'cert.pem'
        }
        print(f"Ejecutando en HTTPS en puerto {port}")
        socketio.run(app, host=host, port=port, debug=True, use_reloader=False, **ssl_args)
    else:
        print(f"Ejecutando en HTTP en puerto {port} (SSL no disponible)")
        socketio.run(app, host=host, port=port, debug=True, use_reloader=False)