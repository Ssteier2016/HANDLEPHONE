let ws;
let userId;
let audioChunks = [];
let audioContext = new (window.AudioContext || window.webkitAudioContext)();
let mediaRecorder;
let stream;
let map;
let audioQueue = [];
let isPlaying = false;
let flightData = [];
let markers = [];
let recognition; // Variable para SpeechRecognition

const AIRLINE_MAPPING = {
    "ARG": "Aerolíneas Argentinas",
    "AEP": "AEP"
};

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

// Inicializar SpeechRecognition
if ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window) {
    recognition = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
    recognition.lang = 'es-ES';
    recognition.continuous = true;
    recognition.interimResults = true;
} else {
    console.error("SpeechRecognition no soportado en este navegador.");
    alert("Tu navegador no soporta speech-to-text. Usa Chrome para mejor compatibilidad.");
}

async function requestMicPermission() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        console.log("Micrófono permitido");
        return stream;
    } catch (err) {
        console.error("Error al solicitar permiso de micrófono:", err);
        alert("No se pudo acceder al micrófono. Por favor, habilita los permisos en tu navegador.");
        return null;
    }
}

function register() {
    const legajo = document.getElementById("legajo").value;
    const name = document.getElementById("name").value;
    const userFunction = document.getElementById("function").value;
    if (!legajo || !name || !userFunction) {
        alert("Por favor, ingresa un apellido, un legajo y una función.");
        return;
    }
    if (!/^\d{5}$/.test(legajo)) {
        alert("El legajo debe contener exactamente 5 números.");
        return;
    }
    userId = `${legajo}_${name}_${userFunction}`;
    const sessionToken = btoa(userId);
    localStorage.setItem("sessionToken", sessionToken);
    localStorage.setItem("userName", name);
    localStorage.setItem("userFunction", userFunction);
    connectWebSocket(sessionToken);
}

function connectWebSocket(sessionToken) {
    const wsUrl = `wss://${window.location.host}/ws/${sessionToken}`;
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
        ws.send(JSON.stringify({ 
            type: "register", 
            legajo: document.getElementById("legajo").value, 
            name: localStorage.getItem("userName"),
            function: localStorage.getItem("userFunction")
        }));
        document.getElementById("register").style.display = "none";
        const mainDiv = document.getElementById("main");
        if (mainDiv) {
            mainDiv.style.display = "block";
        } else {
            console.error("Elemento #main no encontrado en el DOM");
        }
        updateOpenSkyData();
        // Simular un mensaje después de 2 segundos (para pruebas)
        setTimeout(simulateMessage, 2000);
    };

    ws.onmessage = function(event) {
        try {
            const message = JSON.parse(event.data);
            console.log("Mensaje recibido:", message);

            if (!message.type) {
                console.error("Mensaje sin tipo:", message);
                return;
            }

            if (message.type === "audio") {
                if (!message.data || !message.timestamp || !message.sender || !message.function || !message.text) {
                    console.error("Mensaje de audio incompleto:", message);
                    return;
                }

                const audioBlob = base64ToBlob(message.data, 'audio/webm');
                playAudio(audioBlob);
                const chatList = document.getElementById("chat-list");
                if (!chatList) {
                    console.error("Elemento chat-list no encontrado en el DOM");
                    return;
                }

                const msgDiv = document.createElement("div");
                msgDiv.className = "chat-message";
                const utcTime = message.timestamp.split(":");
                if (utcTime.length !== 2) {
                    console.error("Formato de timestamp inválido:", message.timestamp);
                    return;
                }

                const utcDate = new Date();
                utcDate.setUTCHours(parseInt(utcTime[0]), parseInt(utcTime[1]));
                const localTime = utcDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
                msgDiv.innerHTML = `<span class="play-icon">▶️</span> ${localTime} - ${message.sender} (${message.function}): ${message.text}`;
                msgDiv.onclick = () => playAudio(audioBlob);
                chatList.appendChild(msgDiv);
                chatList.scrollTop = chatList.scrollHeight;
            } else if (message.type === "users") {
                document.getElementById("users").textContent = `Usuarios conectados: ${message.count} (${message.list.join(", ")})`;
            } else {
                console.warn("Tipo de mensaje desconocido:", message.type);
            }
        } catch (err) {
            console.error("Error procesando mensaje:", err, "Datos recibidos:", event.data);
            alert("Error procesando el mensaje recibido.");
        }
    };

    ws.onerror = function(error) {
        console.error("Error en WebSocket:", error);
        alert("No se pudo conectar al servidor. Revisá la consola para más detalles.");
    };

    ws.onclose = function() {
        console.log("WebSocket cerrado");
        const sessionToken = localStorage.getItem("sessionToken");
        if (sessionToken) {
            setTimeout(() => connectWebSocket(sessionToken), 5000);
        }
    };
}

window.onload = function() {
    const sessionToken = localStorage.getItem("sessionToken");
    if (sessionToken) {
        document.getElementById("register").style.display = "none";
        document.getElementById("main").style.display = "block";
        connectWebSocket(sessionToken);
    }
};

function playAudio(blob) {
    const audio = new Audio(URL.createObjectURL(blob));
    audioQueue.push(audio);
    playNextAudio();

    if ('mediaSession' in navigator) {
        navigator.mediaSession.metadata = new MediaSessionMetadata({
            title: 'Mensaje de voz',
            artist: 'HANDLEPHONE',
            album: 'Comunicación Aeronáutica'
        });

        navigator.mediaSession.setActionHandler('play', () => audio.play());
        navigator.mediaSession.setActionHandler('pause', () => audio.pause());
    }
}

function initMap() {
    map = L.map('map').setView([-34.5597, -58.4116], 10);
    L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
        maxZoom: 19,
        attribution: '© OpenStreetMap'
    }).addTo(map);

    var airplaneIcon = L.icon({
        iconUrl: 'templates/airport.png',
        iconSize: [30, 30],
    });

    L.marker([-34.5597, -58.4116], { icon: airplaneIcon }).addTo(map)
        .bindPopup("Aeroparque").openPopup();

    const searchBar = document.getElementById("search-bar");
    searchBar.addEventListener("input", filterFlights);
}

function calculateDistance(lat1, lon1, lat2, lon2) {
    const R = 3440.07;
    const dLat = (lat2 - lat1) * Math.PI / 180;
    const dLon = (lon2 - lon1) * Math.PI / 180;
    const a = Math.sin(dLat / 2) * Math.sin(dLat / 2) +
              Math.cos(lat1 * Math.PI / 180) * Math.cos(lat2 * Math.PI / 180) *
              Math.sin(dLon / 2) * Math.sin(dLon / 2);
    const c = 2 * Math.atan2(Math.sqrt(a), Math.sqrt(1 - a));
    return R * c;
}

function estimateArrivalTime(lat, lon, speed) {
    const aeroparqueLat = -34.5597;
    const aeroparqueLon = -58.4116;
    const distance = calculateDistance(lat, lon, aeroparqueLat, aeroparqueLon);
    if (!speed || speed <= 0) return "N/A";
    const timeHours = distance / speed;
    const now = new Date();
    const arrivalTime = new Date(now.getTime() + timeHours * 60 * 60 * 1000);
    return arrivalTime.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }).toLowerCase().replace(":", "");
}

function getFlightStatus(altitude, speed, verticalRate) {
    if (altitude < 100 && speed < 50) return "En tierra";
    if (altitude >= 100 && altitude <= 2000 && speed > 50) return "Despegando";
    if (altitude > 2000 && verticalRate < 0) return "En zona";
    if (altitude > 2000) return "En vuelo";
    return "Desconocido";
}

function filterFlights() {
    const searchTerm = document.getElementById("search-bar").value.toUpperCase();
    markers.forEach(marker => {
        const flight = marker.flight;
        const registration = marker.registration;
        const flightNumber = flight.replace("ARG", "").replace("AR", "");
        const displayFlight = `AEP${flightNumber}`;
        const matchesSearch = 
            registration.toUpperCase().includes(searchTerm) || 
            displayFlight.toUpperCase().includes(searchTerm) ||
            flightNumber === searchTerm;
        if (matchesSearch) {
            if (!map.hasLayer(marker)) {
                marker.addTo(map);
            }
        } else {
            if (map.hasLayer(marker)) {
                map.removeLayer(marker);
            }
        }
    });
}

function updateOpenSkyData() {
    fetch('/opensky')
        .then(response => response.json())
        .then(data => {
            console.log("Datos recibidos de /opensky:", data);
            const messageList = document.getElementById("message-list");
            messageList.innerHTML = "";
            flightData = data;
            markers = [];

            if (map) {
                map.eachLayer(layer => {
                    if (layer instanceof L.Marker && layer.getPopup().getContent() !== "Aeroparque") {
                        map.removeLayer(layer);
                    }
                });
            }

            if (data.error) {
                console.warn("Error en Airplanes.Live:", data.error);
                messageList.textContent = "Esperando datos de Airplanes.Live...";
            } else {
                data.forEach(state => {
                    const lat = state.lat;
                    const lon = state.lon;
                    const flight = state.flight ? state.flight.trim() : 'N/A';
                    const registration = state.registration || "LV-XXX";
                    const speed = state.gs;
                    const altitude = state.alt_geom || 0;
                    const verticalRate = state.vert_rate || 0;
                    const originDest = state.origin_dest || "N/A";

                    if (flight.startsWith("AR") || flight.startsWith("ARG")) {
                        const flightNumber = flight.replace("ARG", "").replace("AR", "");
                        const displayFlight = `AEP${flightNumber}`;
                        const status = getFlightStatus(altitude, speed, verticalRate);
                        const arrivalTime = estimateArrivalTime(lat, lon, speed);

                        const flightDiv = document.createElement("div");
                        flightDiv.className = `flight-message flight-${status.toLowerCase().replace(" ", "-")}`;
                        flightDiv.textContent = `Aerolíneas Argentinas ${displayFlight} / ${registration} ${status} ${arrivalTime}`;
                        messageList.appendChild(flightDiv);

                        if (lat && lon && map) {
                            const marker = L.marker([lat, lon], { 
                                icon: L.icon({
                                    iconUrl: '/templates/aero.png',
                                    iconSize: [30, 30]
                                })
                            }).addTo(map)
                              .bindPopup(`Vuelo: ${displayFlight} / ${registration}<br>Ruta: ${originDest}<br>Estado: ${status}`);
                            marker.flight = flight;
                            marker.registration = registration;
                            markers.push(marker);
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

async function toggleTalk() {
    const talkButton = document.getElementById("talk");
    if (!mediaRecorder || mediaRecorder.state === "inactive") {
        stream = await requestMicPermission();
        if (!stream) return;

        mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
        audioChunks = [];
        let transcript = ""; // Variable para almacenar la transcripción

        // Iniciar SpeechRecognition
        if (recognition) {
            recognition.onresult = (event) => {
                transcript = "";
                for (let i = event.resultIndex; i < event.results.length; i++) {
                    if (event.results[i].isFinal) {
                        transcript += event.results[i][0].transcript;
                    } else {
                        transcript += event.results[i][0].transcript; // Resultados intermedios
                    }
                }
            };
            recognition.onerror = (event) => {
                console.error("Error en SpeechRecognition:", event.error);
                transcript = "Error en transcripción";
            };
            recognition.start();
        }

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
                    ws.send(JSON.stringify({ 
                        type: "audio", 
                        data: base64data,
                        text: transcript || "Sin transcripción" // Usar transcripción o fallback
                    }));
                }

                // Mostrar el mensaje localmente con la transcripción
                const chatList = document.getElementById("chat-list");
                if (chatList) {
                    const msgDiv = document.createElement("div");
                    msgDiv.className = "chat-message";
                    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
                    const userName = localStorage.getItem("userName") || "Anónimo";
                    const userFunction = localStorage.getItem("userFunction") || "Desconocida";
                    msgDiv.innerHTML = `<span class="play-icon">▶️</span> ${timestamp} - ${userName} (${userFunction}): ${transcript || "Sin transcripción"}`;
                    msgDiv.onclick = () => playAudio(audioBlob);
                    chatList.appendChild(msgDiv);
                    chatList.scrollTop = chatList.scrollHeight;
                }
            };
            console.log("Grabación detenida");
            if (stream) {
                stream.getTracks().forEach(track => track.stop());
                stream = null;
            }
            audioChunks = [];
            mediaRecorder = null;
            if (recognition) recognition.stop(); // Detener SpeechRecognition
        };
        mediaRecorder.start(100);
        talkButton.textContent = "Grabando...";
        talkButton.style.backgroundColor = "green";
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
    localStorage.removeItem("sessionToken");
    localStorage.removeItem("userName");
    localStorage.removeItem("userFunction");
    document.getElementById("register").style.display = "block";
    document.getElementById("main").style.display = "none";
    document.getElementById("radar-screen").style.display = "none";
    document.getElementById("history-screen").style.display = "none";
    if (stream) {
        stream.getTracks().forEach(track => track.stop());
    }
    console.log("Sesión cerrada");
}

function showRadar() {
    document.getElementById("main").style.display = "none";
    document.getElementById("radar-screen").style.display = "block";
    if (!map) {
        initMap();
        updateOpenSkyData();
    } else {
        map.invalidateSize();
        filterFlights();
    }
}

function backToMainFromRadar() {
    document.getElementById("radar-screen").style.display = "none";
    document.getElementById("main").style.display = "block";
    document.getElementById("search-bar").value = "";
    filterFlights();
}

function showHistory() {
    fetch('/history')
        .then(response => response.json())
        .then(data => {
            const historyList = document.getElementById("history-list");
            historyList.innerHTML = "";
            data.forEach(msg => {
                const msgDiv = document.createElement("div");
                msgDiv.className = "chat-message";
                const utcTime = msg.timestamp.split(":");
                const utcDate = new Date();
                utcDate.setUTCHours(parseInt(utcTime[0]), parseInt(utcTime[1]));
                const localTime = utcDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
                msgDiv.innerHTML = `<span class="play-icon">▶️</span> ${msg.date} ${localTime} - ${msg.user_id}: ${msg.text}`;
                const audio = new Audio(`data:audio/webm;base64,${msg.audio}`);
                msgDiv.onclick = () => playAudio(new Blob([base64ToBlob(msg.audio, 'audio/webm')]));
                historyList.appendChild(msgDiv);
            });
            document.getElementById("main").style.display = "none";
            document.getElementById("radar-screen").style.display = "none";
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

function simulateMessage() {
    const simulatedMessage = {
        type: "audio",
        data: "",
        timestamp: "12:34",
        sender: "UsuarioPrueba",
        function: "Piloto",
        text: "Mensaje de prueba"
    };
    ws.onmessage({ data: JSON.stringify(simulatedMessage) });
}
