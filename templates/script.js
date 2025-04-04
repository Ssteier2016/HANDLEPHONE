let ws;
let userId;
let mediaRecorder;
let stream; // Para manejar el flujo de audio

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
        updateOpenSkyData(); // Iniciar actualización periódica
    };
    
    ws.onmessage = function(event) {
        const message = JSON.parse(event.data);
        if (message.type === "audio") {
            const audioBlob = base64ToBlob(message.data, 'audio/webm');
            const audioUrl = URL.createObjectURL(audioBlob);
            const audio = new Audio(audioUrl);
            audio.play();
            const messageList = document.getElementById("message-list");
            const msgDiv = document.createElement("div");
            msgDiv.textContent = `${message.timestamp} - ${message.sender} (${message.matricula_icao}): ${message.text}`;
            messageList.appendChild(msgDiv);
        } else if (message.type === "users") {
            document.getElementById("users").textContent = `Usuarios conectados: ${message.count} (${message.list.join(", ")})`;
        }
    };
    
    ws.onerror = function(error) {
        console.error("Error en WebSocket:", error);
        alert("No se pudo conectar al servidor. Revisa la consola para más detalles.");
    };
    
    ws.onclose = function() {
        console.log("WebSocket cerrado");
    };
}

function initMap() {
    var map = L.map('map').setView([-34.5597, -58.4116], 10);
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
            data.forEach(state => {
                const lat = state[6];
                const lon = state[5];
                if (lat && lon) {
                    const flightDiv = document.createElement("div");
                    flightDiv.textContent = `Vuelo ${state[1] || 'N/A'} (ICAO24: ${state[0]}) - Lat: ${lat}, Lon: ${lon}`;
                    messageList.appendChild(flightDiv);
                }
            });
            // Actualizar el mapa también (opcional)
            const map = L.map('map').setView([-34.5597, -58.4116], 10);
            L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
                maxZoom: 19,
                attribution: '© OpenStreetMap'
            }).addTo(map);
            data.forEach(state => {
                const lat = state[6];
                const lon = state[5];
                if (lat && lon) {
                    L.marker([lat, lon], { 
                        icon: L.icon({
                            iconUrl: 'https://cdn-icons-png.flaticon.com/512/892/892227.png',
                            iconSize: [30, 30]
                        })
                    }).addTo(map)
                      .bindPopup(`ICAO24: ${state[0]}, Llamada: ${state[1]}`);
                }
            });
        })
        .catch(err => console.error("Error al cargar datos de OpenSky:", err));
    setTimeout(updateOpenSkyData, 60000); // Actualizar cada 60 segundos
}

function toggleTalk() {
    const talkButton = document.getElementById("talk");
    if (talkButton.textContent === "Grabando...") {
        mediaRecorder.stop();
        if (stream) {
            stream.getTracks().forEach(track => track.stop()); // Detener el micrófono
        }
        talkButton.textContent = "Hablar";
        talkButton.style.backgroundColor = "red";
    } else {
        navigator.mediaDevices.getUserMedia({ audio: true })
            .then(audioStream => {
                stream = audioStream; // Guardar el stream para detenerlo
                mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
                mediaRecorder.ondataavailable = function(event) {
                    const reader = new FileReader();
                    reader.readAsDataURL(event.data);
                    reader.onloadend = function() {
                        const base64data = reader.result.split(',')[1];
                        ws.send(JSON.stringify({ type: "audio", data: base64data }));
                    };
                };
                mediaRecorder.onstop = function() {
                    console.log("Grabación detenida");
                };
                mediaRecorder.start(100); // Streaming cada 100ms
                talkButton.textContent = "Grabando...";
                talkButton.style.backgroundColor = "green";
            })
            .catch(err => console.error("Error al acceder al micrófono:", err));
    }
}

function toggleMute() {
    const muteButton = document.getElementById("mute");
    if (muteButton.textContent === "Mutear") {
        ws.send(JSON.stringify({ type: "mute" }));
        muteButton.textContent = "Desmutear";
        muteButton.style.backgroundColor = "red";
    } else {
        ws.send(JSON.stringify({ type: "unmute" }));
        muteButton.textContent = "Mutear";
        muteButton.style.backgroundColor = "green";
    }
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
                const audio = new Audio(`data:audio/wav;base64,${msg.audio}`);
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
