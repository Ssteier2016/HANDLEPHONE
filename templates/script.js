let ws;
let userId;
let audioChunks = [];
let audioContext = new (window.AudioContext || window.webkitAudioContext)();
let mediaRecorder;
let stream;
let map;
let audioQueue = [];
let isPlaying = false;

// Mapeo de prefijos de callsign a nombres de aerolíneas (solo Aerolíneas Argentinas)
const AIRLINE_MAPPING = {
    "ARG": "Aerolíneas Argentinas",
    "AEP": "AEP"
};

// Letras permitidas para matrículas argentinas (A-Z)
const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

function register() {
    const legajo = document.getElementById("legajo").value;
    const name = document.getElementById("name").value;
    if (!legajo || !name) {
        alert("Por favor, ingresa un legajo y un nombre.");
        return;
    }
    userId = `${legajo}_${name}`;
    const wsUrl = `wss://${window.location.host}/ws/${userId}`;
    console.log(`Intentando conectar WebSocket a: ${wsUrl}`);
    try {
        ws = new WebSocket(wsUrl);
    } catch (err) {
        console.error("Error al crear WebSocket:", err);
        alert("Error al intentar conectar con el servidor.");
        return;
    }
    
    ws.onopen = function() {
        console.log("WebSocket conectado exitosamente");
        ws.send(JSON.stringify({ type: "register", legajo: legajo, name: name }));
        console.log("Ocultando #register y mostrando #main");
        document.getElementById("register").style.display = "none";
        document.getElementById("main").style.display = "block";
        initMap();
        updateOpenSkyData();
        document.body.addEventListener('touchstart', unlockAudio, { once: true });
    };
    
    ws.onmessage = function(event) {
        const message = JSON.parse(event.data);
        console.log("Mensaje recibido:", message);
        if (message.type === "audio") {
            try {
                const audioBlob = base64ToBlob(message.data, 'audio/webm');
                const audioUrl = URL.createObjectURL(audioBlob);
                const audio = new Audio(audioUrl);
                audioQueue.push(audio);
                playNextAudio();
                const chatList = document.getElementById("chat-list");
                const msgDiv = document.createElement("div");
                msgDiv.textContent = `${message.timestamp} - ${message.sender} (${message.matricula_icao}): ${message.text}`;
                chatList.appendChild(msgDiv);
                chatList.scrollTop = chatList.scrollHeight;
            } catch (err) {
                console.error("Error procesando audio:", err);
                alert("Error procesando el audio recibido.");
            }
        } else if (message.type === "users") {
            document.getElementById("users").textContent = `Usuarios conectados: ${message.count} (${message.list.join(", ")})`;
        }
    };
    
    ws.onerror = function(error) {
        console.error("Error en WebSocket:", error);
        alert("No se pudo conectar al servidor. Revisá la consola para más detalles.");
    };
    
    ws.onclose = function() {
        console.log("WebSocket cerrado");
        logout();
    };
}

function unlockAudio() {
    const audio = new Audio();
    audio.play().catch(() => {});
    console.log("Audio desbloqueado tras interacción");
    alert("Audio desbloqueado. Probá hablar ahora.");
}

function initMap() {
    map = L.map('map').setView([-34.5597, -58.4116], 10);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap'
    }).addTo(map);

    var airplaneIcon = L.icon({
        iconUrl: 'https://cdn-icons-png.flaticon.com/512/149/149498.png', // Ícono de avión más claro
        iconSize: [30, 30],
    });

    L.marker([-34.5597, -58.4116], { icon: airplaneIcon }).addTo(map)
        .bindPopup("Aeroparque").openPopup();
}

// Función para calcular la distancia en millas náuticas entre dos puntos
function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 3440.07; // Radio de la Tierra en millas náuticas
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

// Función para estimar la hora de llegada
function estimateArrivalTime(lat, lon, speed) {
    const aeroparqueLat = -34.5597;
    const aeroparqueLon = -58.4116;
    const distance = calculateDistance(lat, lon, aeroparqueLat, aeroparqueLon);
    if (!speed || speed <= 0) return "N/A";
    const timeHours = distance / speed;
    const now = new Date();
    const arrivalTime = new Date(now.getTime() + timeHours * 60 * 60 * 1000);
    return arrivalTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }).toLowerCase().replace(":", ""); // Ej. "0526 p.m."
}

// Función para determinar el estado del vuelo
function getFlightStatus(altitude, speed, verticalRate) {
    if (altitude < 100 && speed < 50) return "En tierra";
    if (altitude >= 100 && altitude <= 2000 && speed > 50) return "Despegando";
    if (altitude > 2000 && verticalRate < 0) return "Arribando";
    if (altitude > 2000) return "En vuelo";
    return "Desconocido"; // Fallback
}

function updateOpenSkyData() {
    fetch('/opensky')
        .then(response => response.json())
        .then(data => {
            console.log("Datos recibidos de /opensky:", data); // Para depurar
            const messageList = document.getElementById("message-list");
            messageList.innerHTML = "";
            map.eachLayer(layer => {
                if (layer instanceof L.Marker && layer.getPopup().getContent() !== "Aeroparque") {
                    map.removeLayer(layer);
                }
            });
            if (data.error) {
                console.warn("Error en Airplanes.Live:", data.error);
                messageList.textContent = "Esperando datos de Airplanes.Live...";
            } else {
                data.forEach(state => {
                    const lat = state.lat;
                    const lon = state.lon;
                    const flight = state.flight ? state.flight.trim() : 'N/A';
                    const registration = state.registration || "LV-XXX"; // Matrícula real de TAMS
                    const speed = state.gs;
                    const altitude = state.alt_geom || 0; // Altitud en pies
                    const verticalRate = state.vert_rate || 0; // Tasa vertical en pies/minuto
                    const originDest = state.origin_dest || "N/A"; // Origen/Destino de TAMS

                    // Filtrar solo vuelos de Aerolíneas Argentinas
                    if (flight.startsWith("AR") || flight.startsWith("ARG")) {
                        const flightNumber = flight.replace("ARG", "").replace("AR", ""); // Extraer número
                        const displayFlight = `AEP${flightNumber}`; // Usar "AEP" como prefijo
                        const status = getFlightStatus(altitude, speed, verticalRate);
                        const arrivalTime = estimateArrivalTime(lat, lon, speed);

                        const flightDiv = document.createElement("div");
                        flightDiv.textContent = `Aerolíneas Argentinas ${displayFlight} / ${registration} ${status} ${arrivalTime}`;
                        messageList.appendChild(flightDiv);

                        if (lat && lon) {
                            L.marker([lat, lon], { 
                                icon: L.icon({
                                    iconUrl: 'https://cdn-icons-png.flaticon.com/512/149/149498.png', // Ícono de avión
                                    iconSize: [30, 30]
                                })
                            }).addTo(map)
                              .bindPopup(`Vuelo: ${displayFlight} / ${registration}<br>Ruta: ${originDest}<br>Estado: ${status}`);
                        }
                    }
                });
                messageList.scrollTop = messageList.scrollHeight;
            }
        })
        .catch(err => {
            console.error("Error al cargar datos de Airplanes.Live:", err);
            document.getElementById("message-list").textContent = "Error al conectar con Airplanes.Live";
        });
    setTimeout(updateOpenSkyData, 15000);
}

function toggleTalk() {
    const talkButton = document.getElementById("talk");
    if (!mediaRecorder || mediaRecorder.state === "inactive") {
        navigator.mediaDevices.getUserMedia({ audio: true })
            .then(audioStream => {
                stream = audioStream;
                mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
                audioChunks = [];
                mediaRecorder.ondataavailable = function(event) {
                    audioChunks.push(event.data);
                };
                mediaRecorder.onstop = function() {
                    const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
                    const reader = new FileReader();
                    reader.readAsDataURL(audioBlob);
                    reader.onloadend = function() {
                        const base64data = reader.result.split(',')[1];
                        if (ws && ws.readyState === WebSocket.OPEN) {
                            ws.send(JSON.stringify({ type: "audio", data: base64data }));
                        }
                    };
                    console.log("Grabación detenida");
                    if (stream) {
                        stream.getTracks().forEach(track => track.stop());
                        stream = null;
                    }
                    audioChunks = [];
                };
                mediaRecorder.start(100);
                talkButton.textContent = "Grabando...";
                talkButton.style.backgroundColor = "green";
            })
            .catch(err => console.error("Error al acceder al micrófono:", err));
    } else if (mediaRecorder.state === "recording") {
        mediaRecorder.stop();
        talkButton.textContent = "Hablar";
        talkButton.style.backgroundColor = "red";
    }
}

function toggleMute() {
    const muteButton = document.getElementById("mute");
    if (muteButton.textContent === "Mutear") {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "mute" }));
        }
        muteButton.textContent = "Desmutear";
        muteButton.style.backgroundColor = "red";
    } else {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "unmute" }));
        }
        muteButton.textContent = "Mutear";
        muteButton.style.backgroundColor = "green";
    }
}

function logout() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "logout" }));
        ws.close();
    }
    console.log("Mostrando #register y ocultando #main y #history-screen");
    document.getElementById("register").style.display = "block";
    document.getElementById("main").style.display = "none";
    document.getElementById("history-screen").style.display = "none";
    if (stream) {
        stream.getTracks().forEach(track => track.stop());
    }
    console.log("Sesión cerrada");
}

function showHistory() {
    fetch('/history')
        .then(response => response.json())
        .then(data => {
            const historyList = document.getElementById("history-list");
            historyList.innerHTML = "";
            data.forEach(msg => {
                const msgDiv = document.createElement("div");
                msgDiv.textContent = `${msg.date} ${msg.timestamp} - ${msg.user_id}: ${msg.text}`;
                const audio = new Audio(`data:audio/webm;base64,${msg.audio}`);
                msgDiv.onclick = () => audio.play();
                historyList.appendChild(msgDiv);
            });
            document.getElementById("main").style.display = "none";
            document.getElementById("history-screen").style.display = "block";
        })
        .catch(err => console.error("Error al cargar historial:", err));
}

function backToMain() {
    document.getElementById("history-screen").style.display = "none";
    document.getElementById("main").style.display = "block";
}

function base64ToBlob(base64, mime) {
    const byteString = atob(base64);
    const arrayBuffer = new ArrayBuffer(byteString.length);
    const uint8Array = new Uint8Array(arrayBuffer);
    for (let i = 0; i < byteString.length; i++) {
        uint8Array[i] = byteString.charCodeAt(i);
    }
    return new Blob([uint8Array], { type: mime });
}

function playNextAudio() {
    if (audioQueue.length === 0 || isPlaying) return;
    isPlaying = true;
    const audio = audioQueue.shift();
    audio.play().then(() => {
        console.log("Audio reproducido exitosamente");
        isPlaying = false;
        playNextAudio();
    }).catch(err => {
        console.error("Error reproduciendo audio:", err);
        alert("No se pudo reproducir el audio. Hacé clic en la pantalla primero.");
        isPlaying = false;
        playNextAudio();
    });
}
