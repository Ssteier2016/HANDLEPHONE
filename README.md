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
   ```

## 🔊 Modelo de voz para Vosk (Español)

Para que la funcionalidad de transcripción de voz a texto funcione correctamente, es necesario descargar manualmente el modelo de voz de Vosk en español.

📅 **[Descargar modelo Vosk ES desde Google Drive](https://drive.google.com/file/d/1A5Coj8R7G0gA9FYF8HdGq5f67TJuePAd/view?usp=drive_link)**

> 🔐 El modelo no está incluido en este repositorio por su gran tamaño (más de 1 GB).

### Instrucciones:

1. Hacé clic en el enlace de descarga: https://drive.google.com/file/d/1A5Coj8R7G0gA9FYF8HdGq5f67TJuePAd/view?usp=drive_link
2. Descomprimí el archivo `.zip`.
3. Colocá la carpeta `vosk-model-es-0.42` dentro de la carpeta `Model` en el mismo directorio del proyecto.

La estructura debe quedar así:

```
handlephone/
│
├── Model/
│   └── vosk-model-es-0.42/
│       ├── am/
│       ├── conf/
│       ├── graph/
│       └── ...
