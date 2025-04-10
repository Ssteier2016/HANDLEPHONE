// Variables globales
let ws; // WebSocket para la comunicación con el servidor
let userId; // Identificador único del usuario (legajo_name_function)
let audioChunks = []; // Almacena fragmentos de audio durante la grabación
let audioContext = new (window.AudioContext || window.webkitAudioContext)(); // Contexto de audio para reproducción
let mediaRecorder; // Objeto para grabar audio
let stream; // Stream de audio del micrófono
let map; // Mapa de Leaflet para el radar
let audioQueue = []; // Cola para reproducir audios en secuencia
let isPlaying = false; // Bandera para evitar superposición de reproducción de audios
let flightData = []; // Almacena datos de vuelos recibidos de /opensky
let markers = []; // Marcadores en el mapa para los vuelos
let recognition; // Objeto para SpeechRecognition (transcripción de voz)
let supportsSpeechRecognition = false; // Bandera para verificar soporte de SpeechRecognition
let mutedUsers = new Set(); // Estado local para rastrear usuarios muteados

// Mapeo de aerolíneas y letras para posibles conversiones
const AIRLINE_MAPPING = {
    "ARG": "Aerolíneas Argentinas",
    "AEP": "AEP"
};

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZ";

// Inicializar SpeechRecognition y verificar soporte
if ('SpeechRecognition' in window || 'webkitSpeechRecognition' in window) {
    recognition = new (window.SpeechRecognition || window.webkitSpeechRecognition)();
    recognition.lang = 'es-ES';
    recognition.continuous = true;
    recognition.interimResults = true;
    supportsSpeechRecognition = true;
    console.log("SpeechRecognition soportado. Navegador:", navigator.userAgent);
} else {
    console.error("SpeechRecognition no soportado en este navegador. Navegador:", navigator.userAgent);
    alert("Tu navegador no soporta speech-to-text en el cliente. El servidor transcribirá el audio.");
}

// Función para desbloquear el contexto de audio (necesario en algunos navegadores)
function unlockAudio() {
    if (audioContext.state === 'suspended') {
        audioContext.resume().then(() => {
            console.log("Contexto de audio desbloqueado");
        }).catch(err => {
            console.error("Error al desbloquear el contexto de audio:", err);
        });
    }
}

// Desbloquear el audio al interactuar con la página
document.addEventListener('click', unlockAudio, { once: true });

// Solicitar permiso para usar el micrófono
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

// Función para registrar al usuario
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
    localStorage.setItem("userLegajo", legajo); // Guardar legajo por separado
    connectWebSocket(sessionToken);
}

// Conectar al WebSocket
function connectWebSocket(sessionToken, retryCount = 0, maxRetries = 5) {
    const wsUrl = `wss://${window.location.host}/ws/${sessionToken}`;
    console.log(`Intentando conectar WebSocket a: ${wsUrl} (Intento ${retryCount + 1}/${maxRetries})`);
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
    };

    ws.onmessage = function(event) {
        console.log("Datos recibidos del servidor:", event.data);
        try {
            const message = JSON.parse(event.data);
            console.log("Mensaje parseado:", message);

            if (!message.type) {
                console.error("Mensaje sin tipo:", message);
                return;
            }

            if (message.type === "audio") {
                if (!message.data) {
                    console.error("Mensaje de audio sin datos de audio:", message);
                    return;
                }
                const senderId = `${message.sender}_${message.function}`;
                if (mutedUsers.has(senderId)) {
                    console.log(`Mensaje de ${senderId} ignorado porque está muteado`);
                    return;
                }
                const audioBlob = base64ToBlob(message.data, 'audio/webm');
                console.log("Audio Blob creado para reproducción, tamaño:", audioBlob.size, "bytes");
                playAudio(audioBlob);
                const chatList = document.getElementById("chat-list");
                if (!chatList) {
                    console.error("Elemento chat-list no encontrado en el DOM");
                    return;
                }

                const msgDiv = document.createElement("div");
                msgDiv.className = "chat-message";
                const timestamp = message.timestamp || new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
                const sender = message.sender || "Anónimo";
                const userFunction = message.function || "Desconocida";
                const text = message.text || "Sin transcripción";
                msgDiv.innerHTML = `<span class="play-icon">▶️</span> ${timestamp} - ${sender} (${userFunction}): ${text}`;
                msgDiv.onclick = () => playAudio(audioBlob);
                chatList.appendChild(msgDiv);
                chatList.scrollTop = chatList.scrollHeight;
                console.log("Mensaje de audio agregado al chat-list");
            } else if (message.type === "users") {
                const usersDiv = document.getElementById("users");
                usersDiv.innerHTML = `Usuarios conectados: ${message.count} `;
                const userList = document.createElement("div");
                userList.className = "user-list";
                message.list.forEach(user => {
                    const userDiv = document.createElement("div");
                    userDiv.className = "user-item";
                    const muteButton = document.createElement("button");
                    muteButton.className = "mute-button";
                    const isMuted = mutedUsers.has(user.user_id);
                    muteButton.textContent = isMuted ? "🔇" : "🔊";
                    muteButton.onclick = () => toggleMuteUser(user.user_id, muteButton);
                    userDiv.appendChild(muteButton);
                    const userText = document.createElement("span");
                    userText.textContent = user.display;
                    userDiv.appendChild(userText);
                    userList.appendChild(userDiv);
                });
                usersDiv.appendChild(userList);
                console.log("Lista de usuarios actualizada:", message.list);
            } else if (message.type === "reconnect-websocket") {
                const sessionToken = localStorage.getItem("sessionToken");
                if (sessionToken) {
                    connectWebSocket(sessionToken);
                }
                console.log("Intentando reconectar WebSocket...");
            } else {
                console.warn("Tipo de mensaje desconocido:", message.type);
            }
        } catch (err) {
            console.error("Error procesando mensaje:", err, "Datos recibidos:", event.data);
        }
    };

    ws.onerror = function(error) {
        console.error("Error en WebSocket:", error);
    };

    ws.onclose = function() {
        console.log("WebSocket cerrado");
        const sessionToken = localStorage.getItem("sessionToken");
        if (sessionToken && retryCount < maxRetries) {
            setTimeout(() => connectWebSocket(sessionToken, retryCount + 1, maxRetries), 5000);
        } else if (retryCount >= maxRetries) {
            console.error("Máximo número de intentos de reconexión alcanzado. Por favor, recarga la página.");
            alert("No se pudo reconectar al servidor después de varios intentos. Por favor, recarga la página.");
        }
    };
}

// Cargar la página y verificar si el usuario ya está autenticado
window.onload = function() {
    console.log("window.onload ejecutado");
    const sessionToken = localStorage.getItem("sessionToken");
    console.log("sessionToken:", sessionToken);
    const registerDiv = document.getElementById("register");
    const mainDiv = document.getElementById("main");
    const radarDiv = document.getElementById("radar-screen");
    const historyDiv = document.getElementById("history-screen");

    if (!registerDiv || !mainDiv || !radarDiv || !historyDiv) {
        console.error("Uno o más elementos no se encontraron en el DOM:", {
            registerDiv: !!registerDiv,
            mainDiv: !!mainDiv,
            radarDiv: !!radarDiv,
            historyDiv: !!historyDiv
        });
        return;
    }

    if (sessionToken) {
        console.log("Usuario autenticado, mostrando pantalla principal");
        registerDiv.style.display = "none";
        mainDiv.style.display = "block";
        radarDiv.style.display = "none";
        historyDiv.style.display = "none";
        connectWebSocket(sessionToken);
    } else {
        console.log("Usuario no autenticado, mostrando pantalla de registro");
        registerDiv.style.display = "block";
        mainDiv.style.display = "none";
        radarDiv.style.display = "none";
        historyDiv.style.display = "none";
    }
};

// Manejo de doble toque en el botón de volumen (+) para activar la grabación
let lastVolumeUpTime = 0;
let volumeUpCount = 0;

document.addEventListener('keydown', (event) => {
    if (event.key === 'VolumeUp') {
        event.preventDefault(); // Evitar el comportamiento predeterminado
        const currentTime = Date.now();
        const timeDiff = currentTime - lastVolumeUpTime;

        if (timeDiff < 500) { // 500ms para considerar un doble toque
            volumeUpCount++;
            if (volumeUpCount === 2) {
                toggleTalk(); // Activar el botón "Hablar"
                volumeUpCount = 0; // Reiniciar el contador
            }
        } else {
            volumeUpCount = 1; // Reiniciar el contador si el tiempo entre toques es mayor
        }
        lastVolumeUpTime = currentTime;
    }
});

// Reproducir audio recibido
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

// Reproducir el siguiente audio en la cola
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
        isPlaying = false;
        playNextAudio();
    });
}

// Inicializar el mapa de Leaflet para el radar
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

// Calcular la distancia entre dos puntos (en millas náuticas)
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

// Estimar la hora de llegada basada en la distancia y velocidad
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

// Determinar el estado del vuelo
function getFlightStatus(altitude, speed, verticalRate) {
    if (altitude < 100 && speed < 50) return "En tierra";
    if (altitude >= 100 && altitude <= 2000 && speed > 50) return "Despegando";
    if (altitude > 2000 && verticalRate < 0) return "En zona";
    if (altitude > 2000) return "En vuelo";
    return "Desconocido";
}

// Filtrar vuelos en el radar según la búsqueda
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

// Actualizar datos de vuelos desde /opensky
function updateOpenSkyData() {
    fetch('/opensky')
        .then(response => response.json())
        .then(data => {
            console.log("Datos recibidos de /opensky:", data);
            const flightDetails = document.getElementById("flight-details");
            if (!flightDetails) {
                console.error("Elemento #flight-details no encontrado en el DOM");
                return;
            }
            flightDetails.innerHTML = "";
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
                flightDetails.textContent = "Esperando datos de Airplanes.Live...";
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
                    const scheduled = state.scheduled || "N/A";
                    const position = state.position || "N/A";
                    const destination = state.destination || "N/A";
                    const status = state.status || getFlightStatus(altitude, speed, verticalRate);

                    if (flight.startsWith("AR") || flight.startsWith("ARG")) {
                        const flightNumber = flight.replace("ARG", "").replace("AR", "");
                        const displayFlight = `AEP${flightNumber}`;

                        // Mostrar en #flight-details
                        const flightDiv = document.createElement("div");
                        flightDiv.className = `flight flight-${status.toLowerCase().replace(" ", "-")}`;
                        flightDiv.innerHTML = `
                            <strong>Vuelo:</strong> ${displayFlight} | 
                            <strong>STD:</strong> ${scheduled} | 
                            <strong>Posición:</strong> ${position} | 
                            <strong>Destino:</strong> ${destination} | 
                            <strong>Matrícula:</strong> ${registration} | 
                            <strong>Estado:</strong> ${status}
                        `;
                        flightDetails.appendChild(flightDiv);

                        // Mostrar en el mapa (si está visible)
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
                flightDetails.scrollTop = flightDetails.scrollHeight;
            }
        })
        .catch(err => {
            console.error("Error al cargar datos de Airplanes.Live:", err);
            const flightDetails = document.getElementById("flight-details");
            if (flightDetails) {
                flightDetails.textContent = "Error al conectar con Airplanes.Live";
            }
        });
    setTimeout(updateOpenSkyData, 15000);
}

// Alternar la grabación de audio
async function toggleTalk() {
    const talkButton = document.getElementById("talk");
    if (!mediaRecorder || mediaRecorder.state === "inactive") {
        console.log("Iniciando grabación...");
        stream = await requestMicPermission();
        if (!stream) {
            console.error("No se pudo obtener el stream del micrófono");
            return;
        }

        try {
            mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
            console.log("MediaRecorder creado con mimeType: audio/webm");
        } catch (err) {
            console.error("Error al crear MediaRecorder:", err);
            alert("Error al iniciar la grabación: " + err.message);
            return;
        }

        audioChunks = [];
        let transcript = supportsSpeechRecognition ? "" : "Pendiente de transcripción";

        if (supportsSpeechRecognition && recognition) {
            recognition.onresult = (event) => {
                transcript = "";
                for (let i = event.resultIndex; i < event.results.length; i++) {
                    if (event.results[i].isFinal) {
                        transcript += event.results[i][0].transcript;
                    } else {
                        transcript += event.results[i][0].transcript;
                    }
                }
                console.log("Transcripción parcial:", transcript);
            };
            recognition.onerror = (event) => {
                console.error("Error en SpeechRecognition:", event.error);
                transcript = "Error en transcripción: " + event.error;
                alert("Error en speech-to-text: " + event.error);
            };
            try {
                recognition.start();
                console.log("SpeechRecognition iniciado");
            } catch (err) {
                console.error("Error al iniciar SpeechRecognition:", err);
            }
        }

        mediaRecorder.ondataavailable = function(event) {
            console.log("Datos de audio disponibles:", event.data.size, "bytes");
            audioChunks.push(event.data);
        };
        mediaRecorder.onstop = function() {
            console.log("Grabación detenida");
            console.log("Tamaño de audioChunks:", audioChunks.length);
            const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
            console.log("Audio Blob creado, tamaño:", audioBlob.size, "bytes");
            const reader = new FileReader();
            reader.readAsDataURL(audioBlob);
            reader.onloadend = function() {
                const base64data = reader.result.split(',')[1];
                console.log("Audio convertido a Base64, longitud:", base64data.length);
                const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
                const sender = localStorage.getItem("userName") || "Anónimo";
                const userFunction = localStorage.getItem("userFunction") || "Desconocida";
                if (ws && ws.readyState === WebSocket.OPEN) {
                    ws.send(JSON.stringify({ 
                        type: "audio", 
                        data: base64data,
                        text: transcript,
                        timestamp: timestamp,
                        sender: sender,
                        function: userFunction
                    }));
                    console.log("Enviado al servidor:", { data: base64data.slice(0, 20) + "...", text: transcript, timestamp, sender, function: userFunction });
                } else {
                    console.error("WebSocket no está abierto. Estado:", ws ? ws.readyState : "WebSocket no definido");
                    alert("No se pudo enviar el mensaje: WebSocket no está conectado.");
                }

                const chatList = document.getElementById("chat-list");
                if (chatList) {
                    const msgDiv = document.createElement("div");
                    msgDiv.className = "chat-message";
                    msgDiv.innerHTML = `<span class="play-icon">▶️</span> ${timestamp} - ${sender} (${userFunction}): ${transcript}`;
                    msgDiv.onclick = () => playAudio(audioBlob);
                    chatList.appendChild(msgDiv);
                    chatList.scrollTop = chatList.scrollHeight;
                } else {
                    console.error("Elemento #chat-list no encontrado en el DOM");
                }
            };
            reader.onerror = function(err) {
                console.error("Error al leer el audio como Base64:", err);
            };
            if (stream) {
                stream.getTracks().forEach(track => track.stop());
                stream = null;
            }
            audioChunks = [];
            mediaRecorder = null;
            if (supportsSpeechRecognition && recognition) recognition.stop();
        };
        mediaRecorder.onerror = function(err) {
            console.error("Error en MediaRecorder:", err);
            alert("Error durante la grabación: " + err);
        };
        try {
            mediaRecorder.start(100);
            console.log("Grabación iniciada");
            talkButton.textContent = "Grabando...";
            talkButton.style.backgroundColor = "green";
        } catch (err) {
            console.error("Error al iniciar la grabación:", err);
            alert("Error al iniciar la grabación: " + err.message);
        }
    } else if (mediaRecorder.state === "recording") {
        mediaRecorder.stop();
        talkButton.textContent = "Hablar";
        talkButton.style.backgroundColor = "red";
    }
}

// Función actualizada para alternar mute/desmute sin texto
function toggleMute() {
    const muteButton = document.getElementById("mute");
    if (muteButton.classList.contains("active")) {
        // Desmutear
        muteButton.classList.remove("active");
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "unmute" }));
        }
        console.log("Desmuteado");
    } else {
        // Mutear
        muteButton.classList.add("active");
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "mute" }));
        }
        console.log("Muteado");
    }
}

function toggleMuteUser(userId, button) {
    if (mutedUsers.has(userId)) {
        // Desmutear
        mutedUsers.delete(userId);
        button.textContent = "🔊";
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "unmute_user", target_user_id: userId }));
        }
        console.log(`Usuario ${userId} desmuteado`);
    } else {
        // Mutear
        mutedUsers.add(userId);
        button.textContent = "🔇";
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "mute_user", target_user_id: userId }));
        }
        console.log(`Usuario ${userId} muteado`);
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
    localStorage.removeItem("userLegajo");
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
    try {
        const byteString = atob(base64);
        const arrayBuffer = new ArrayBuffer(byteString.length);
        const uint8Array = new Uint8Array(arrayBuffer);
        for (let i = 0; i < byteString.length; i++) {
            uint8Array[i] = byteString.charCodeAt(i);
        }
        return new Blob([uint8Array], { type: mime });
    } catch (err) {
        console.error("Error al convertir Base64 a Blob:", err);
        return null;
    }
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
        isPlaying = false;
        playNextAudio();
    });
}

// Agregar event listener para el botón de registro
document.addEventListener('DOMContentLoaded', () => {
    const registerButton = document.getElementById('register-button');
    if (registerButton) {
        registerButton.addEventListener('click', register);
    } else {
        console.error("Botón de registro no encontrado en el DOM");
    }
});
        
