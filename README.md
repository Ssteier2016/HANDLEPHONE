# HandlePhone App

Esta es una aplicación web que simula un walkie-talkie en tiempo real, permitiendo a los usuarios grabar y transmitir mensajes de voz automáticamente a otros usuarios conectados. Incluye funcionalidades como mutear/desmutear, historial de mensajes con transcripción de voz a texto, y un registro básico de usuarios.

## Características
- **Botón "Hablar"**: Graba y transmite audio en tiempo real (cambia de rojo a verde al grabar).
- **Botón "Mutear"**: Silencia la recepción de mensajes (cambia de verde a rojo).
- **Botón "Historial"**: Muestra mensajes pasados con audio y texto, organizados por fecha.
- **Cartel "Mensajes"**: Muestra mensajes en tiempo real con transcripción (se borra cada 9 horas desde las 5:30 UTC).
- **Usuarios conectados**: Muestra la cantidad y nombres de usuarios en línea.
- **Registro**: Requiere número de legajo y nombre para conectarse.

## Tecnologías utilizadas
- **Backend**: Python, FastAPI, WebSockets
- **Audio**: PyAudio
- **Speech-to-Text**: SpeechRecognition con CMU Sphinx
- **Frontend**: HTML, CSS, JavaScript
- **Base de datos**: SQLite
- **Despliegue**: Render

## Requisitos previos
- Python 3.8 o superior
- Git
- Una cuenta en [Render](https://render.com) para el despliegue
- (Opcional) Micrófono y altavoces para pruebas locales

## Instalación local
1. Clona el repositorio:
   ```bash
   git clone https://github.com/Ssteier2016/handlephone.git
   cd handlephone
