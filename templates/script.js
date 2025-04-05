let ws;
let userId;
let audioChunks = [];
let audioContext = new (window.AudioContext || window.webkitAudioContext)();
let mediaRecorder;
let stream;
let map;
let audioQueue = [];
let isPlaying = false;

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
            console.log("Datos recibidos de /opensky:", data); // Para depurar
            const messageList = document.getElementById("message-list");
            messageList.innerHTML = "";
            map.eachLayer(layer => {
                if (layer instanceof L.Marker && layer.getPopup().getContent() !== "Aeroparque") {
                    map.removeLayer(layer); // Solo elimina marcadores de vuelos, no Aeroparque
                }
            });
            if (data.error) {
                console.warn("Error en Airplanes.Live:", data.error);
                messageList.textContent = "Esperando datos de Airplanes.Live...";
            } else {
                data.forEach(state => {
                    const lat = state.lat;  // Airplanes.Live usa "lat"
                    const lon = state.lon;  // Airplanes.Live usa "lon"
                    const hex = state.hex;  // ICAO24
                    const flight = state.flight || 'N/A';  // Callsign
                    if (lat && lon) {
                        const flightDiv = document.createElement("div");
                        flightDiv.textContent = `Vuelo ${flight} (ICAO24: ${hex}) - Lat: ${lat}, Lon: ${lon}`;
                        messageList.appendChild(flightDiv);
                        L.marker([lat, lon], { 
                            icon: L.icon({
                                iconUrl: 'https://cdn-icons-png.flaticon.com/512/892/892227.png',
                                iconSize: [30, 30]
                            })
                        }).addTo(map)
                          .bindPopup(`ICAO24: ${hex}, Llamada: ${flight}`);
                    }
                });
                messageList.scrollTop = messageList.scrollHeight;
            }
        })
        .catch(err => {
            console.error("Error al cargar datos de Airplanes.Live:", err);
            document.getElementById("message-list").textContent = "Error al conectar con Airplanes.Live";
        });
    setTimeout(updateOpenSkyData, 15000); // Mantenemos tus 15 segundos
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
