let ws;
let userId;
let mediaRecorder;
let audioChunks = [];

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
        initMap(); // Inicializar el mapa después de registrarse
    };
    
    ws.onmessage = function(event) {
        const message = JSON.parse(event.data);
        if (message.type === "audio") {
            const audio = new Audio(`data:audio/wav;base64,${message.data}`);
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
    var map = L.map('map').setView([-34.5597, -58.4116], 10); // Centro en Aeroparque
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

function toggleTalk() {
    const talkButton = document.getElementById("talk");
    if (talkButton.textContent === "Grabando...") {
        mediaRecorder.stop();
        talkButton.textContent = "Hablar";
        talkButton.style.backgroundColor = "red";
    } else {
        navigator.mediaDevices.getUserMedia({ audio: true })
            .then(stream => {
                mediaRecorder = new MediaRecorder(stream);
                audioChunks = [];
                mediaRecorder.ondataavailable = function(event) {
                    audioChunks.push(event.data);
                };
                mediaRecorder.onstop = function() {
                    const audioBlob = new Blob(audioChunks, { type: 'audio/wav' });
                    const reader = new FileReader();
                    reader.readAsDataURL(audioBlob);
                    reader.onloadend = function() {
                        const base64data = reader.result.split(',')[1];
                        ws.send(JSON.stringify({ type: "audio", data: base64data }));
                    };
                    stream.getTracks().forEach(track => track.stop());
                };
                mediaRecorder.start();
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
