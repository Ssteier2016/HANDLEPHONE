from fastapi import FastAPI, WebSocket, WebSocketDisconnect, Form, Request, Depends
from fastapi.staticfiles import StaticFiles
from fastapi.templating import Jinja2Templates
from fastapi.responses import HTMLResponse, RedirectResponse
from starlette.middleware.cors import CORSMiddleware
import uvicorn
import logging
import sqlite3
import bcrypt
import secrets
import json
from datetime import datetime, timedelta

logging.basicConfig(level=logging.INFO)
logger = logging.getLogger(__name__)

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=True,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.mount("/templates", StaticFiles(directory="templates"), name="templates")
templates = Jinja2Templates(directory="templates")

# Conjunto para almacenar clientes conectados y sus datos
connected_clients = set()
connected_users = {}

# Inicializar bases de datos
def init_db():
    conn = sqlite3.connect("users.db")
    c = conn.cursor()
    c.execute('''CREATE TABLE IF NOT EXISTS users (
        username TEXT PRIMARY KEY,
        password TEXT NOT NULL
    )''')
    c.execute('''CREATE TABLE IF NOT EXISTS sessions (
        token TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        FOREIGN KEY (username) REFERENCES users (username)
    )''')
    conn.commit()
    conn.close()

def init_chat_db():
    conn = sqlite3.connect("chat.db")
    c = conn.cursor()
    c.execute('''CREATE TABLE IF NOT EXISTS messages (
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        type TEXT,
        sender TEXT,
        content TEXT,
        timestamp TEXT
    )''')
    conn.commit()
    conn.close()

def clean_old_messages():
    conn = sqlite3.connect("chat.db")
    c = conn.cursor()
    seven_days_ago = (datetime.now() - timedelta(days=7)).strftime("%Y-%m-%d %H:%M:%S")
    c.execute("DELETE FROM messages WHERE timestamp < ?", (seven_days_ago,))
    conn.commit()
    conn.close()

init_db()
init_chat_db()

# Obtener el usuario actual a partir del token de sesión
def get_current_user(request: Request):
    token = request.cookies.get("session_token")
    if not token:
        return RedirectResponse(url="/login", status_code=303)

    conn = sqlite3.connect("users.db")
    c = conn.cursor()
    c.execute("SELECT username FROM sessions WHERE token = ?", (token,))
    session_data = c.fetchone()
    if not session_data:
        conn.close()
        return RedirectResponse(url="/login", status_code=303)

    username = session_data[0]
    c.execute("SELECT username FROM users WHERE username = ?", (username,))
    user = c.fetchone()
    conn.close()

    if not user:
        return RedirectResponse(url="/login", status_code=303)

    return {"username": user[0]}

# Página de registro
@app.get("/register", response_class=HTMLResponse)
async def register_page(request: Request):
    if request.cookies.get("session_token"):
        return RedirectResponse(url="/", status_code=303)
    return templates.TemplateResponse("register.html", {"request": request})

# Registro de usuario
@app.post("/register", response_class=HTMLResponse)
async def register(
    request: Request,
    username: str = Form(...),
    password: str = Form(...),
    confirm_password: str = Form(...)
):
    if request.cookies.get("session_token"):
        return RedirectResponse(url="/", status_code=303)

    if len(username) < 3:
        return templates.TemplateResponse("register.html", {
            "request": request,
            "error": "El nombre de usuario debe tener al menos 3 caracteres."
        })

    if password != confirm_password:
        return templates.TemplateResponse("register.html", {
            "request": request,
            "error": "Las contraseñas no coinciden."
        })

    if len(password) < 6:
        return templates.TemplateResponse("register.html", {
            "request": request,
            "error": "La contraseña debe tener al menos 6 caracteres."
        })

    hashed_password = bcrypt.hashpw(password.encode('utf-8'), bcrypt.gensalt())
    try:
        conn = sqlite3.connect("users.db")
        c = conn.cursor()
        c.execute("INSERT INTO users (username, password) VALUES (?, ?)",
                  (username, hashed_password))
        conn.commit()
        conn.close()
    except sqlite3.IntegrityError:
        return templates.TemplateResponse("register.html", {
            "request": request,
            "error": "El nombre de usuario ya está registrado."
        })

    return RedirectResponse(url="/login", status_code=303)

# Página de inicio de sesión
@app.get("/login", response_class=HTMLResponse)
async def login_page(request: Request):
    if request.cookies.get("session_token"):
        return RedirectResponse(url="/", status_code=303)
    return templates.TemplateResponse("login.html", {"request": request})

# Inicio de sesión
@app.post("/login", response_class=HTMLResponse)
async def login(
    request: Request,
    username: str = Form(...),
    password: str = Form(...)
):
    if request.cookies.get("session_token"):
        return RedirectResponse(url="/", status_code=303)

    conn = sqlite3.connect("users.db")
    c = conn.cursor()
    c.execute("SELECT * FROM users WHERE username = ?", (username,))
    user = c.fetchone()
    conn.close()

    if not user:
        return templates.TemplateResponse("login.html", {
            "request": request,
            "error": "Usuario no registrado. Por favor, regístrate primero."
        })

    stored_password = user[1]
    if not bcrypt.checkpw(password.encode('utf-8'), stored_password):
        return templates.TemplateResponse("login.html", {
            "request": request,
            "error": "Contraseña incorrecta."
        })

    session_token = secrets.token_hex(16)
    conn = sqlite3.connect("users.db")
    c = conn.cursor()
    c.execute("INSERT INTO sessions (token, username) VALUES (?, ?)", (session_token, username))
    conn.commit()
    conn.close()

    response = RedirectResponse(url="/", status_code=303)
    response.set_cookie(key="session_token", value=session_token, httponly=True, max_age=30*24*60*60)
    return response

# Cerrar sesión
@app.get("/logout", response_class=HTMLResponse)
async def logout(request: Request):
    token = request.cookies.get("session_token")
    if token:
        conn = sqlite3.connect("users.db")
        c = conn.cursor()
        c.execute("DELETE FROM sessions WHERE token = ?", (token,))
        conn.commit()
        conn.close()

        user_to_remove = None
        for ws, user in connected_users.items():
            if user["token"] == token:
                user_to_remove = ws
                break
        if user_to_remove:
            del connected_users[user_to_remove]

    response = RedirectResponse(url="/login", status_code=303)
    response.delete_cookie(key="session_token")
    return response

# Página de recuperación de contraseña
@app.get("/reset-password", response_class=HTMLResponse)
async def reset_password_page(request: Request):
    if request.cookies.get("session_token"):
        return RedirectResponse(url="/", status_code=303)
    return templates.TemplateResponse("reset_password.html", {"request": request})

# Recuperación de contraseña
@app.post("/reset-password", response_class=HTMLResponse)
async def reset_password(
    request: Request,
    username: str = Form(...),
    new_password: str = Form(...),
    confirm_new_password: str = Form(...)
):
    if request.cookies.get("session_token"):
        return RedirectResponse(url="/", status_code=303)

    conn = sqlite3.connect("users.db")
    c = conn.cursor()
    c.execute("SELECT * FROM users WHERE username = ?", (username,))
    user = c.fetchone()

    if not user:
        conn.close()
        return templates.TemplateResponse("reset_password.html", {
            "request": request,
            "error": "Usuario no registrado."
        })

    if new_password != confirm_new_password:
        conn.close()
        return templates.TemplateResponse("reset_password.html", {
            "request": request,
            "error": "Las contraseñas no coinciden."
        })

    if len(new_password) < 6:
        conn.close()
        return templates.TemplateResponse("reset_password.html", {
            "request": request,
            "error": "La contraseña debe tener al menos 6 caracteres."
        })

    hashed_password = bcrypt.hashpw(new_password.encode('utf-8'), bcrypt.gensalt())
    c.execute("UPDATE users SET password = ? WHERE username = ?", (hashed_password, username))
    conn.commit()
    conn.close()

    return RedirectResponse(url="/login", status_code=303)

# Página principal
@app.get("/", response_class=HTMLResponse)
async def read_root(request: Request, user: dict = Depends(get_current_user)):
    if isinstance(user, RedirectResponse):
        return user
    return templates.TemplateResponse("index.html", {
        "request": request,
        "user": user
    })

# Obtener lista de usuarios conectados
@app.get("/users")
async def get_users(user: dict = Depends(get_current_user)):
    if isinstance(user, RedirectResponse):
        return user
    users = [{"username": user["username"]} for user in connected_users.values()]
    return {"users": users}

# Obtener historial de chat
@app.get("/chat_history")
async def get_chat_history(user: dict = Depends(get_current_user)):
    if isinstance(user, RedirectResponse):
        return user

    conn = sqlite3.connect("chat.db")
    c = conn.cursor()
    seven_days_ago = (datetime.now() - timedelta(days=7)).strftime("%Y-%m-%d %H:%M:%S")
    c.execute("SELECT type, sender, content, timestamp FROM messages WHERE timestamp >= ? ORDER BY timestamp ASC", (seven_days_ago,))
    messages = [
        {
            "type": row[0],
            "sender": row[1],
            "content": row[2],
            "timestamp": row[3]
        } for row in c.fetchall()
    ]
    conn.close()
    return messages

# WebSocket para manejar el chat
@app.websocket("/chat")
async def chat_endpoint(websocket: WebSocket):
    await websocket.accept()
    connected_clients.add(websocket)

    token = None
    for header in websocket.headers.items():
        if header[0] == "cookie":
            cookies = header[1].split("; ")
            for cookie in cookies:
                if cookie.startswith("session_token="):
                    token = cookie.split("=")[1]
                    break
            break

    username = None
    if token:
        conn = sqlite3.connect("users.db")
        c = conn.cursor()
        c.execute("SELECT username FROM sessions WHERE token = ?", (token,))
        session_data = c.fetchone()
        if session_data:
            username = session_data[0]
            connected_users[websocket] = {"token": token, "username": username}
        conn.close()

    if not username:
        await websocket.close()
        return

    # Notificar a todos que un usuario se unió
    join_message = {
        "type": "chat_message",
        "username": "Sistema",
        "message": f"{username} se ha unido al chat.",
        "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
    }
    await broadcast_message(join_message)

    try:
        while True:
            data = await websocket.receive()
            if "text" in data:
                message = json.loads(data["text"])
                message["timestamp"] = datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                message["username"] = username

                # Guardar el mensaje en la base de datos
                conn = sqlite3.connect("chat.db")
                c = conn.cursor()
                c.execute(
                    "INSERT INTO messages (type, sender, content, timestamp) VALUES (?, ?, ?, ?)",
                    (
                        message["type"],
                        message["username"],
                        message["message"] if message["type"] == "chat_message" else "[Mensaje de voz]",
                        message["timestamp"]
                    )
                )
                conn.commit()
                conn.close()

                clean_old_messages()
                await broadcast_message(message)

            elif "bytes" in data:
                audio_message = {
                    "type": "audio_message",
                    "username": username,
                    "audio": data["bytes"],
                    "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
                }

                # Guardar el mensaje de audio en la base de datos (solo metadatos)
                conn = sqlite3.connect("chat.db")
                c = conn.cursor()
                c.execute(
                    "INSERT INTO messages (type, sender, content, timestamp) VALUES (?, ?, ?, ?)",
                    (
                        audio_message["type"],
                        audio_message["username"],
                        "[Mensaje de voz]",
                        audio_message["timestamp"]
                    )
                )
                conn.commit()
                conn.close()

                clean_old_messages()
                await broadcast_audio(audio_message)

    except WebSocketDisconnect:
        connected_clients.remove(websocket)
        if websocket in connected_users:
            del connected_users[websocket]
        leave_message = {
            "type": "chat_message",
            "username": "Sistema",
            "message": f"{username} ha abandonado el chat.",
            "timestamp": datetime.now().strftime("%Y-%m-%d %H:%M:%S")
        }
        await broadcast_message(leave_message)

# Enviar mensajes de texto a todos los clientes
async def broadcast_message(message):
    message_str = json.dumps(message)
    for client in connected_clients:
        try:
            await client.send_text(message_str)
        except WebSocketDisconnect:
            connected_clients.discard(client)
            if client in connected_users:
                del connected_users[client]

# Enviar mensajes de audio a todos los clientes
async def broadcast_audio(message):
    for client in connected_clients:
        try:
            await client.send_bytes(message["audio"])
        except WebSocketDisconnect:
            connected_clients.discard(client)
            if client in connected_users:
                del connected_users[client]

if __name__ == "__main__":
    uvicorn.run(app, host="0.0.0.0", port=8000)
