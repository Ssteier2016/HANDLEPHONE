let ws;
let userId;
let audioChunks = [];
let audioContext = new (window.AudioContext || window.webkitAudioContext)();
let mediaRecorder;
let stream;
let map;
let audioQueue = []; // Cola para los audios
let isPlaying = false; // Bandera para controlar reproducción

function register() {
    const legajo = document.getElementById("legajo").value;
    const name = document.getElementById("name").value;
    if (!legajo || !name) {
        alert("Por favor, ingresa un legajo y un nombre.");
        return;
    }
    userId = `${legajo}_${name}`;
    console.log(`Intentando conectar WebSocket para ${userId} a wss://${window.location.host}/ws/${userId}`);
    ws = new WebSocket(`wss://${window.location.host}/ws/${userId}`);
    
    ws.onopen = function() {
        console.log("WebSocket conectado exitosamente");
        ws.send(JSON.stringify({ type: "register", legajo: legajo, name: name }));
        document.getElementById("register").style.display = "none";
        document.getElementById("main").style.display = "block";
        initMap();
        updateOpenSkyData(); // Iniciar actualización de datos
        document.body.addEventListener('touchstart', unlockAudio, { once: true }); // Para celulares
    };
    
    ws.onmessage = function(event) {
        const message = JSON.parse(event.data);
        console.log("Mensaje recibido:", message);
        if (message.type === "audio") {
            try {
                const audioBlob = base64ToBlob(message.data, 'audio/webm');
                const audioUrl = URL.createObjectURL(audioBlob);
                const audio = new Audio(audioUrl);
                audioQueue.push(audio); // Agregar audio a la cola
                playNextAudio(); // Reproducir el siguiente audio si no hay uno en curso
                // Agregar a la ventana de chat
                const chatList = document.getElementById("chat-list");
                const msgDiv = document.createElement("div");
                msgDiv.textContent = `${message.timestamp} - ${message.sender} (${message.matricula_icao}): ${message.text}`;
                chatList.appendChild(msgDiv);
                chatList.scrollTop = chatList.scrollHeight; // Auto-scroll
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
        alert("No se pudo conectar al servidor.");
    };
    
    ws.onclose = function() {
        console.log("WebSocket cerrado");
        logout(); // Asegurar que la UI refleje el cierre
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
        iconUrl: 'https://cdn-icons-png.flaticon.com/512/892/892227.png',
        iconSize: [30, 30],
    });

    L.marker([-34.5597, -58.4116], { icon: airplaneIcon }).addTo(map)
        .bindPopup("Aeroparque").openPopup();
}

function updateOpenSkyData() {
    fetch('/opensky')
        .then(response => response.json())
        .then(data => {
            const messageList = document.getElementById("message-list");
            messageList.innerHTML = ""; // Limpiar para evitar duplicados
            map.eachLayer(layer => {
                if (layer instanceof L.Marker) map.removeLayer(layer);
            });
            if (data.error) {
                console.warn("Error en OpenSky:", data.error);
                messageList.textContent = "Esperando datos de OpenSky...";
            } else {
                data.forEach(state => {
                    const lat = state[6];
                    const lon = state[5];
                    if (lat && lon) {
                        const flightDiv = document.createElement("div");
                        flightDiv.textContent = `Vuelo ${state[1] || 'N/A'} (ICAO24: ${state[0]}) - Lat: ${lat}, Lon: ${lon}`;
                        messageList.appendChild(flightDiv);
                        L.marker([lat, lon], { 
                            icon: L.icon({
                                iconUrl: 'https://cdn-icons-png.flaticon.com/512/892/892227.png',
                                iconSize: [30, 30]
                            })
                        }).addTo(map)
                          .bindPopup(`ICAO24: ${state[0]}, Llamada: ${state[1] || 'N/A'}`);
                    }
                });
                messageList.scrollTop = messageList.scrollHeight; // Auto-scroll
            }
        })
        .catch(err => {
            console.error("Error al cargar datos de OpenSky:", err);
            document.getElementById("message-list").textContent = "Error al conectar con OpenSky";
        });
    setTimeout(updateOpenSkyData, 10000); // Actualizar cada 10 segundos
}

function toggleTalk() {
    const talkButton = document.getElementById("talk");
    if (!mediaRecorder || mediaRecorder.state === "inactive") {
        // Iniciar grabación
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
                    // Limpiar stream y audioChunks
                    if (stream) {
                        stream.getTracks().forEach(track => track.stop());
                        stream = null;
                    }
                    audioChunks = [];
                };
                mediaRecorder.start(100); // Grabar en intervalos de 100ms
                talkButton.textContent = "Grabando...";
                talkButton.style.backgroundColor = "green";
            })
            .catch(err => console.error("Error al acceder al micrófono:", err));
    } else if (mediaRecorder.state === "recording") {
        // Detener grabación
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
    document.getElementById("register").style.display = "block";
    document.getElementById("main").style.display = "none";
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
