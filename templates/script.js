// Variables globales
let ws = null;
let pingInterval = null;
let userId;
let audioChunks = [];
let audioContext = new (window.AudioContext || window.webkitAudioContext)();
let mediaRecorder;
let stream;
let map;
let audioQueue = [];
let isPlaying = false;
let markers = [];
let recognition;
let supportsSpeechRecognition = false;
let mutedUsers = new Set();
let currentGroup = null;
let isSwiping = false;
let startX = 0;
let currentX = 0;
let flightData = [];
let reconnectInterval = null;
const PING_INTERVAL = 30000; // Ping cada 30 segundos
const RECONNECT_BASE_DELAY = 5000; // Reintento base cada 5 segundos
const SYNC_TAG = 'sync-messages'; // Tag para sincronización

// Mapeo de aerolíneas
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
    supportsSpeechRecognition = true;
    console.log("SpeechRecognition soportado. Navegador:", navigator.userAgent);
} else {
    console.warn("SpeechRecognition no soportado. Navegador:", navigator.userAgent);
    alert("Tu navegador no soporta speech-to-text en el cliente. El servidor transcribirá el audio.");
}

// Restaurar sesión al cargar la página
document.addEventListener('DOMContentLoaded', () => {
    registerServiceWorker();
    const sessionToken = localStorage.getItem('sessionToken');
    const userName = localStorage.getItem('userName');
    const userFunction = localStorage.getItem('userFunction');
    const userLegajo = localStorage.getItem('userLegajo');

    if (sessionToken && userName && userFunction && userLegajo) {
        userId = `${userLegajo}_${userName}_${userFunction}`;
        connectWebSocket(sessionToken);
        document.getElementById('register').style.display = 'none';
        document.getElementById('main').style.display = 'block';
        checkGroupStatus();
    }

    const registerButton = document.getElementById('register-button');
    if (registerButton) {
        registerButton.addEventListener('click', register);
    } else {
        console.error("Botón de registro no encontrado en el DOM");
    }

    const searchButton = document.getElementById('search-button');
    if (searchButton) {
        searchButton.addEventListener('click', sendSearchQuery);
    } else {
        console.error("Botón de búsqueda no encontrado en el DOM");
    }

    checkNotificationPermission();
    navigator.serviceWorker.addEventListener('message', event => {
        if (event.data && event.data.type === 'SEND_MESSAGE' && ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify(event.data.message));
            console.log('Mensaje sincronizado enviado:', event.data.message);
        } else if (event.data && event.data.type === 'SYNC_COMPLETE') {
            console.log('Sincronización completada');
        }
    });
});

// Manejar visibilidad de la pestaña
document.addEventListener('visibilitychange', () => {
    if (document.hidden) {
        console.log('App en segundo plano');
    } else {
        console.log('App en primer plano');
        if (ws && ws.readyState !== WebSocket.OPEN) {
            const sessionToken = localStorage.getItem('sessionToken');
            if (sessionToken) {
                connectWebSocket(sessionToken);
            }
        }
    }
});

function queueMessageForSync(message) {
    if ('serviceWorker' in navigator && navigator.serviceWorker.controller) {
        navigator.serviceWorker.controller.postMessage({
            type: 'QUEUE_MESSAGE',
            message: message
        });
        console.log('Mensaje enviado al Service Worker para encolar');
        navigator.serviceWorker.ready.then(registration => {
            registration.sync.register(SYNC_TAG).catch(err => {
                console.error('Error al registrar sync:', err);
            });
        });
    } else {
        console.error('Service Worker no está disponible para encolar mensaje');
        alert('No se pudo guardar el mensaje. Por favor, verifica la conexión.');
    }
}

// Funciones de audio
function unlockAudio() {
    if (audioContext.state === 'suspended') {
        audioContext.resume().then(() => {
            console.log("Contexto de audio desbloqueado");
        }).catch(err => {
            console.error("Error al desbloquear el contexto de audio:", err);
        });
    }
}

async function requestMicPermission() {
    try {
        const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
        console.log("Micrófono permitido");
        return stream;
    } catch (err) {
        console.error("Error al solicitar permiso de micrófono:", err);
        alert("No se pudo acceder al micrófono. Por favor, habilita los permisos.");
        return null;
    }
}

function playAudio(blob) {
    if (!blob || blob.size === 0) {
        console.error("Blob de audio inválido o vacío");
        return;
    }
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

// Funciones de búsqueda
function sendSearchQuery() {
    const query = document.getElementById('search-input').value.trim();
    if (!query) {
        alert('Ingresá una consulta');
        return;
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'search_query', query }));
        localStorage.setItem('lastSearchQuery', query);
        document.getElementById('search-input').value = '';
        console.log(`Consulta enviada: ${query}`);
    } else {
        alert('No conectado al servidor');
        console.error("WebSocket no está abierto. Estado:", ws ? ws.readyState : "WebSocket no definido");
        localStorage.removeItem('lastSearchQuery');
    }
}

function displaySearchResponse(message) {
    const flightDetails = document.getElementById('flight-details');
    const groupFlightDetails = document.getElementById('group-flight-details');
    if (!flightDetails || !groupFlightDetails) {
        console.error("Elementos #flight-details o #group-flight-details no encontrados en el DOM");
        return;
    }
    flightDetails.innerHTML = '';
    groupFlightDetails.innerHTML = '';

    let flights = [];
    if (typeof message === 'string') {
        flights = parseFlightMessage(message);
    } else if (Array.isArray(message)) {
        flights = message.map(flight => ({
            flightNumber: flight.Vuelo || flight.flight_number || 'N/A',
            destination: flight.Destino || flight.arrival_airport || flight.origin_destination || 'N/A',
            status: flight.Estado || flight.flight_status || flight.status || 'Desconocido',
            source: flight.source || 'unknown' // Identificar fuente (fr24, aa2000, etc.)
        }));
    } else {
        console.error("Formato de respuesta de búsqueda inválido:", message);
        const div = document.createElement('div');
        div.className = 'flight no-results';
        div.textContent = 'Error al procesar la búsqueda.';
        flightDetails.appendChild(div);
        groupFlightDetails.appendChild(div.cloneNode(true));
        return;
    }

    const searchQuery = localStorage.getItem('lastSearchQuery') || '';
    const filteredFlights = flights.filter(flight =>
        flight.flightNumber.toLowerCase().includes(searchQuery.toLowerCase()) ||
        flight.destination.toLowerCase().includes(searchQuery.toLowerCase())
    );

    if (filteredFlights.length === 0) {
        const div = document.createElement('div');
        div.className = 'flight no-results';
        div.textContent = 'No se encontraron vuelos para la búsqueda.';
        flightDetails.appendChild(div);
        groupFlightDetails.appendChild(div.cloneNode(true));
    } else {
        filteredFlights.forEach(flight => {
            const div = document.createElement('div');
            const sourceTag = flight.source === 'fr24' ? '[FR24]' : flight.source === 'aa2000' ? '[AA2000]' : '';
            div.className = `flight flight-${flight.status.toLowerCase().replace(" ", "-")}`;
            div.innerHTML = `
                <strong>Vuelo:</strong> ${flight.flightNumber} ${sourceTag} |
                <strong>Destino:</strong> ${flight.destination} |
                <strong>Estado:</strong> ${flight.status}
            `;
            flightDetails.appendChild(div);
            groupFlightDetails.appendChild(div.cloneNode(true));
        });
    }

    flightDetails.scrollTop = flightDetails.scrollHeight;
    groupFlightDetails.scrollTop = groupFlightDetails.scrollHeight;
    console.log("Respuesta de búsqueda mostrada:", filteredFlights);
}

function parseFlightMessage(message) {
    const flights = [];
    try {
        if (typeof message === 'string') {
            const flightEntries = message.split(", ");
            for (let i = 0; i < flightEntries.length; i += 3) {
                if (flightEntries[i].startsWith("AR")) {
                    flights.push({
                        flightNumber: flightEntries[i],
                        destination: flightEntries[i + 1].split(" ")[2] || 'N/A',
                        status: flightEntries[i + 2] || 'Desconocido',
                        source: 'unknown'
                    });
                }
            }
        }
    } catch (err) {
        console.error("Error al parsear mensaje de vuelos:", err);
    }
    return flights;
}

// Funciones de registro y conexión
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
    localStorage.setItem("userLegajo", legajo);
    connectWebSocket(sessionToken);
}

function connectWebSocket(sessionToken, retryCount = 0) {
    const wsUrl = `wss://${window.location.host}/ws/${sessionToken}`;
    console.log(`Intentando conectar WebSocket a: ${wsUrl} (Intento ${retryCount + 1})`);
    try {
        ws = new WebSocket(wsUrl);
    } catch (err) {
        console.error("Error al crear WebSocket:", err);
        alert("Error al intentar conectar con el servidor.");
        return;
    }

    ws.onopen = function() {
        console.log("WebSocket conectado exitosamente");
        clearInterval(reconnectInterval);
        ws.send(JSON.stringify({
            type: "register",
            legajo: localStorage.getItem("userLegajo"),
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
        updateUsers(0, []);
        updateOpenSkyData();
        startPing();
        if ('serviceWorker' in navigator) {
            navigator.serviceWorker.ready.then(registration => {
                registration.sync.register(SYNC_TAG).catch(err => {
                    console.error('Error al registrar sync al reconectar:', err);
                });
            });
        }
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

            if (message.type === "audio" || message.type === "group_message") {
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
                if (!audioBlob) {
                    console.error("No se pudo crear el Blob para el mensaje de audio");
                    return;
                }
                playAudio(audioBlob);
                const chatListId = message.type === "group_message" ? "group-chat-list" : "chat-list";
                const chatList = document.getElementById(chatListId);
                if (!chatList) {
                    console.error(`Elemento ${chatListId} no encontrado en el DOM`);
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
                console.log(`Mensaje de ${message.type} agregado al ${chatListId}`);
            } else if (message.type === "users") {
                updateUsers(message.count, message.list);
            } else if (message.type === "mute_all_success") {
                updateMuteButton(true);
                console.log("Muteo global activado");
            } else if (message.type === "unmute_all_success") {
                updateMuteButton(false);
                console.log("Muteo global desactivado");
            } else if (message.type === "mute_non_group_success") {
                message.user_ids.forEach(userId => mutedUsers.add(userId));
                updateUsers(message.count, message.list);
                document.getElementById("mute-non-group").classList.add("muted");
                document.getElementById("mute-non-group").textContent = "Desmutear no grupo";
                console.log("Usuarios fuera del grupo muteados");
            } else if (message.type === "unmute_non_group_success") {
                message.user_ids.forEach(userId => mutedUsers.delete(userId));
                updateUsers(message.count, message.list);
                document.getElementById("mute-non-group").classList.remove("muted");
                document.getElementById("mute-non-group").textContent = "Mutear no grupo";
                console.log("Usuarios fuera del grupo desmuteados");
            } else if (message.type === "group_joined") {
                currentGroup = message.group_id;
                localStorage.setItem('groupId', currentGroup);
                document.getElementById('main').style.display = 'none';
                document.getElementById('group-screen').style.display = 'block';
                if (message.is_private) {
                    const logoutButton = document.getElementById('logout-button');
                    if (logoutButton) logoutButton.style.display = 'none';
                }
                updateSwipeHint();
                console.log(`Unido al grupo: ${message.group_id}, privado: ${message.is_private}`);
            } else if (message.type === "create_group_success") {
                currentGroup = message.group_id;
                localStorage.setItem('groupId', currentGroup);
                document.getElementById('main').style.display = 'none';
                document.getElementById('group-screen').style.display = 'block';
                if (message.is_private) {
                    const logoutButton = document.getElementById('logout-button');
                    if (logoutButton) logoutButton.style.display = 'none';
                }
                updateSwipeHint();
                alert(`Grupo ${message.group_id} creado exitosamente`);
                console.log(`Grupo creado: ${message.group_id}, privado: ${message.is_private}`);
            } else if (message.type === "create_group_error") {
                alert(`Error al crear el grupo: ${message.message}`);
                console.error(`Error al crear grupo: ${message.message}`);
            } else if (message.type === "check_group") {
                if (!message.in_group) {
                    currentGroup = null;
                    localStorage.removeItem('groupId');
                    updateSwipeHint();
                    console.log("No estás en el grupo, currentGroup restablecido a null");
                }
            } else if (message.type === "flight_update") {
                updateFlightDetails(message.flights, "#flight-details");
                updateFlightDetails(message.flights, "#group-flight-details");
            } else if (message.type === "aa2000_flight_update") {
                updateFlightDetailsAA2000(message.flights, "#flight-details");
                updateFlightDetailsAA2000(message.flights, "#group-flight-details");
            } else if (message.type === "fr24_update") {
                updateFlightDetailsFR24(message.flights, "#flight-details");
                updateFlightDetailsFR24(message.flights, "#group-flight-details");
                updateFlightRadar24Markers(message.flights);
                console.log("Actualización AviationStack recibida:", message.flights);
            } else if (message.type === "search_response") {
                displaySearchResponse(message.message);
            } else if (message.type === "register_success") {
                console.log("Registro exitoso:", message.message);
            } else if (message.type === "logout_success") {
                console.log("Cierre de sesión exitoso");
                logout();
            } else if (message.type === "pong") {
                console.log("Pong recibido del servidor");
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
        stopPing();
        const sessionToken = localStorage.getItem('sessionToken');
        if (sessionToken) {
            const delay = Math.min(RECONNECT_BASE_DELAY * Math.pow(2, retryCount), 30000);
            reconnectInterval = setTimeout(() => {
                connectWebSocket(sessionToken, retryCount + 1);
            }, delay);
        } else {
            console.error("No hay sessionToken para reconectar");
            document.getElementById("main").style.display = "none";
            document.getElementById("register").style.display = "block";
        }
    };
}

// Mantener conexión viva con ping
function startPing() {
    stopPing();
    pingInterval = setInterval(() => {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: 'ping' }));
            console.log("Ping enviado al servidor");
        }
    }, PING_INTERVAL);
}

function stopPing() {
    if (pingInterval) {
        clearInterval(pingInterval);
        pingInterval = null;
    }
}

// Funciones de vuelos
function updateFlightDetails(flights, containerId) {
    const container = document.getElementById(containerId.slice(1));
    if (!container) {
        console.error(`Elemento ${containerId} no encontrado en el DOM`);
        return;
    }
    container.innerHTML = "";
    flights.forEach(state => {
        const flight = state.Vuelo || "N/A";
        const scheduled = state.STD || "N/A";
        const position = state.Posicion || "N/A";
        const destination = state.Destino || "N/A";
        const registration = state.Matricula || "LV-XXX";
        const status = state.Estado || "Desconocido";
        const source = state.source || "unknown";
        const sourceTag = source === 'fr24' ? '[FR24]' : '';

        if (flight.startsWith("AR")) {
            const flightNumber = flight.replace("AR", "");
            const displayFlight = `AEP${flightNumber}`;
            const flightDiv = document.createElement("div");
            flightDiv.className = `flight flight-${status.toLowerCase().replace(" ", "-")}`;
            flightDiv.innerHTML = `
                <strong>Vuelo:</strong> ${displayFlight} ${sourceTag} |
                <strong>STD:</strong> ${scheduled} |
                <strong>Posición:</strong> ${position} |
                <strong>Destino:</strong> ${destination} |
                <strong>Matrícula:</strong> ${registration} |
                <strong>Estado:</strong> ${status}
            `;
            container.appendChild(flightDiv);
        }
    });
    container.scrollTop = container.scrollHeight;
}

function updateFlightDetailsAA2000(flights, containerId) {
    const container = document.getElementById(containerId.slice(1));
    if (!container) {
        console.error(`Elemento ${containerId} no encontrado en el DOM`);
        return;
    }
    container.innerHTML = "";
    flights.forEach(flight => {
        const flightNumber = flight.flight_number || "N/A";
        const scheduled = flight.scheduled_time || "N/A";
        const destination = flight.origin_destination || "N/A";
        const status = flight.status || "Desconocido";
        const gate = flight.gate || "N/A";
        const flightType = flight.flight_type === "partidas" ? "Salida" : "Llegada";
        const sourceTag = '[AA2000]';

        const flightDiv = document.createElement("div");
        flightDiv.className = `flight flight-${status.toLowerCase().replace(" ", "-")}`;
        flightDiv.innerHTML = `
            <strong>Vuelo:</strong> ${flightNumber} ${sourceTag} |
            <strong>STD:</strong> ${scheduled} |
            <strong>Destino:</strong> ${destination} |
            <strong>Puerta:</strong> ${gate} |
            <strong>Tipo:</strong> ${flightType} |
            <strong>Estado:</strong> ${status}
        `;
        container.appendChild(flightDiv);
    });
    container.scrollTop = container.scrollHeight;
}

function updateFlightDetailsFR24(flights, containerId) {
    const container = document.getElementById(containerId.slice(1));
    if (!container) {
        console.error(`Elemento ${containerId} no encontrado en el DOM`);
        return;
    }
    container.innerHTML = "";
    flights.forEach(flight => {
        const flightNumber = flight.flight_number || "N/A";
        const scheduled = flight.departure_time || "N/A";
        const destination = flight.arrival_airport || "N/A";
        const status = flight.flight_status || "Desconocido";
        const gate = flight.gate || "N/A";
        const flightType = flight.flight_type === "departure" ? "Salida" : "Llegada";
        const sourceTag = '[FR24]';

        const flightDiv = document.createElement("div");
        flightDiv.className = `flight flight-${status.toLowerCase().replace(" ", "-")}`;
        flightDiv.innerHTML = `
            <strong>Vuelo:</strong> ${flightNumber} ${sourceTag} |
            <strong>STD:</strong> ${scheduled} |
            <strong>Destino:</strong> ${destination} |
            <strong>Puerta:</strong> ${gate} |
            <strong>Tipo:</strong> ${flightType} |
            <strong>Estado:</strong> ${status}
        `;
        container.appendChild(flightDiv);
    });
    container.scrollTop = container.scrollHeight;
}

function updateFlightRadar24Markers(flights) {
    if (map) {
        markers = markers.filter(marker => !marker.isFlightRadar24);
        flights.forEach(flight => {
            if (flight.latitude && flight.longitude) {
                const marker = L.marker([flight.latitude, flight.longitude], {
                    icon: L.icon({
                        iconUrl: '/templates/aero.png',
                        iconSize: [30, 30]
                    })
                }).addTo(map)
                  .bindPopup(`Vuelo: ${flight.flight_number} [FR24]<br>Origen: ${flight.departure_airport}<br>Destino: ${flight.arrival_airport}<br>Estado: ${flight.flight_status}`);
                marker.flight = flight.flight_number;
                marker.isFlightRadar24 = true;
                markers.push(marker);
            }
        });
        console.log("Marcadores AviationStack actualizados:", flights.length);
    }
}

async function updateOpenSkyData() {
    try {
        let openskyData = [];
        let aa2000Data = [];
        let fr24Data = [];

        try {
            const openskyResponse = await fetch('/opensky');
            if (openskyResponse.ok) {
                openskyData = await openskyResponse.json();
                console.log("Datos recibidos de /opensky:", openskyData);
            } else {
                console.warn("Error al cargar /opensky:", openskyResponse.status);
            }
        } catch (error) {
            console.error("Error en la solicitud a /opensky:", error);
        }

        try {
            const aa2000Response = await fetch('/aa2000_flights');
            if (aa2000Response.ok) {
                aa2000Data = await aa2000Response.json();
                console.log("Datos recibidos de /aa2000_flights:", aa2000Data);
            } else {
                console.warn("Error al cargar /aa2000_flights:", aa2000Response.status);
                aa2000Data = [];
            }
        } catch (error) {
            console.error("Error en la solicitud a /aa2000_flights:", error);
            aa2000Data = [];
        }

        try {
            const fr24Response = await fetch('/fr24_flights');
            if (fr24Response.ok) {
                fr24Data = await fr24Response.json();
                console.log("Datos recibidos de /fr24_flights:", fr24Data);
            } else {
                console.warn("Error al cargar /fr24_flights:", fr24Response.status);
                fr24Data = [];
            }
        } catch (error) {
            console.error("Error en la solicitud a /fr24_flights:", error);
            fr24Data = [];
        }

        const flightDetails = document.getElementById("flight-details");
        const groupFlightDetails = document.getElementById("group-flight-details");
        if (!flightDetails || !groupFlightDetails) {
            console.error("Elementos #flight-details o #group-flight-details no encontrados en el DOM");
            return;
        }
        flightDetails.innerHTML = "";
        groupFlightDetails.innerHTML = "";
        flightData = [...openskyData, ...aa2000Data, ...fr24Data];

        if (map) {
            markers = markers.filter(marker => marker.isFlightRadar24 || marker.getPopup().getContent() === "Aeroparque");
        }

        if (openskyData.error) {
            console.warn("Error en Airplanes.Live:", openskyData.error);
            flightDetails.textContent = "Esperando datos de Airplanes.Live...";
            groupFlightDetails.textContent = "Esperando datos de Airplanes.Live...";
        } else {
            openskyData.forEach(state => {
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
                    groupFlightDetails.appendChild(flightDiv.cloneNode(true));

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
        }

        aa2000Data.forEach(flight => {
            const flightNumber = flight.flight_number || "N/A";
            const scheduled = flight.scheduled_time || "N/A";
            const destination = flight.origin_destination || "N/A";
            const status = flight.status || "Desconocido";
            const gate = flight.gate || "N/A";
            const flightType = flight.flight_type === "partidas" ? "Salida" : "Llegada";
            const flightDiv = document.createElement("div");
            flightDiv.className = `flight flight-${status.toLowerCase().replace(" ", "-")}`;
            flightDiv.innerHTML = `
                <strong>Vuelo:</strong> ${flightNumber} [AA2000] |
                <strong>STD:</strong> ${scheduled} |
                <strong>Destino:</strong> ${destination} |
                <strong>Puerta:</strong> ${gate} |
                <strong>Tipo:</strong> ${flightType} |
                <strong>Estado:</strong> ${status}
            `;
            flightDetails.appendChild(flightDiv);
            groupFlightDetails.appendChild(flightDiv.cloneNode(true));
        });

        fr24Data.forEach(flight => {
            const flightNumber = flight.flight_number || "N/A";
            const scheduled = flight.departure_time || "N/A";
            const destination = flight.arrival_airport || "N/A";
            const status = flight.flight_status || "Desconocido";
            const gate = flight.gate || "N/A";
            const flightType = flight.flight_type === "departure" ? "Salida" : "Llegada";
            const flightDiv = document.createElement("div");
            flightDiv.className = `flight flight-${status.toLowerCase().replace(" ", "-")}`;
            flightDiv.innerHTML = `
                <strong>Vuelo:</strong> ${flightNumber} [FR24] |
                <strong>STD:</strong> ${scheduled} |
                <strong>Destino:</strong> ${destination} |
                <strong>Puerta:</strong> ${gate} |
                <strong>Tipo:</strong> ${flightType} |
                <strong>Estado:</strong> ${status}
            `;
            flightDetails.appendChild(flightDiv);
            groupFlightDetails.appendChild(flightDiv.cloneNode(true));
        });

        flightDetails.scrollTop = flightDetails.scrollHeight;
        groupFlightDetails.scrollTop = groupFlightDetails.scrollHeight;
    } catch (err) {
        console.error("Error al cargar datos de vuelos:", err);
        const flightDetails = document.getElementById("flight-details");
        const groupFlightDetails = document.getElementById("group-flight-details");
        if (flightDetails) flightDetails.textContent = "Error al conectar con los servidores de vuelos";
        if (groupFlightDetails) groupFlightDetails.textContent = "Error al conectar con los servidores de vuelos";
        if (map) {
            markers = markers.filter(marker => marker.isFlightRadar24 || marker.getPopup().getContent() === "Aeroparque");
        }
    }
    setTimeout(updateOpenSkyData, 15000);
}

// Funciones de mapa
function initMap() {
    console.log("Inicializando mapa...");
    const mapContainer = document.getElementById('map');
    if (!mapContainer) {
        console.error("Contenedor #map no encontrado en el DOM");
        alert("Error: No se puede cargar el mapa. Contenedor no encontrado.");
        return;
    }
    try {
        map = L.map('map').setView([-34.5597, -58.4116], 10);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '© OpenStreetMap'
        }).addTo(map);
        const airplaneIcon = L.icon({
            iconUrl: '/templates/airport.png',
            iconSize: [30, 30],
        });
        L.marker([-34.5597, -58.4116], { icon: airplaneIcon })
            .addTo(map)
            .bindPopup("Aeroparque")
            .openPopup();
        console.log("Mapa inicializado correctamente");
        map.invalidateSize();
    } catch (error) {
        console.error("Error al inicializar Leaflet:", error);
        alert("Error al cargar el mapa. Verifica tu conexión o recarga la página.");
    }
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
    const searchTerm = document.getElementById("search-bar").value.toUpperCase().trim();
    console.log("Filtrando vuelos con término:", searchTerm);
    markers.forEach(marker => {
        const flight = marker.flight || "";
        const registration = marker.registration || "";
        const flightNumber = flight.replace("ARG", "").replace("AR", "");
        const displayFlight = `AEP${flightNumber}`;
        const matchesSearch =
            registration.toUpperCase().includes(searchTerm) ||
            displayFlight.toUpperCase().includes(searchTerm) ||
            flightNumber === searchTerm ||
            flight.toUpperCase().includes(searchTerm) ||
            searchTerm === "";
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
    if (map) map.invalidateSize();
    console.log("Vuelos filtrados, marcadores actualizados:", markers.length);
}

// Funciones de grabación
async function toggleTalk() {
    const talkButton = document.getElementById("talk");
    if (!talkButton) {
        console.error("Botón #talk no encontrado en el DOM");
        return;
    }

    if (!mediaRecorder || mediaRecorder.state === "inactive") {
        console.log("Iniciando grabación...");
        stream = await requestMicPermission();
        if (!stream) {
            console.error("No se pudo obtener el stream del micrófono");
            alert("No se pudo acceder al micrófono. Por favor, verifica los permisos.");
            return;
        }

        try {
            mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
            console.log("MediaRecorder creado con mimeType: audio/webm");
        } catch (err) {
            console.error("Error al crear MediaRecorder:", err);
            alert("Error al iniciar la grabación: " + err.message);
            stream.getTracks().forEach(track => track.stop());
            return;
        }

        let audioChunks = [];
        let transcript = supportsSpeechRecognition ? "" : "Procesando...";

        if (supportsSpeechRecognition && recognition) {
            recognition.onresult = (event) => {
                transcript = "";
                for (let i = event.resultIndex; i < event.results.length; i++) {
                    transcript += event.results[i][0].transcript;
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
            if (event.data.size > 0) {
                audioChunks.push(event.data);
            } else {
                console.warn("Fragmento de audio vacío recibido");
            }
        };

        mediaRecorder.onstop = function() {
            console.log("Grabación detenida");
            console.log("Tamaño de audioChunks:", audioChunks.length);
            if (audioChunks.length === 0) {
                console.error("No se capturaron fragmentos de audio");
                alert("No se grabó ningún audio. Verifica tu micrófono.");
                return;
            }
            const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
            console.log("Audio Blob creado, tamaño:", audioBlob.size, "bytes");
            if (audioBlob.size === 0) {
                console.error("Audio Blob vacío");
                alert("El audio grabado está vacío. Verifica tu micrófono.");
                return;
            }
            const reader = new FileReader();
            reader.readAsDataURL(audioBlob);
            reader.onloadend = function() {
                const base64data = reader.result.split(',')[1];
                console.log("Audio convertido a Base64, longitud:", base64data.length);
                const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
                const sender = localStorage.getItem("userName") || "Anónimo";
                const userFunction = localStorage.getItem("userFunction") || "Desconocida";
                const message = {
                    type: "audio",
                    data: base64data,
                    text: transcript,
                    timestamp: timestamp,
                    sender: sender,
                    function: userFunction,
                    sessionToken: localStorage.getItem("sessionToken")
                };

                if (ws && ws.readyState === WebSocket.OPEN) {
                    console.log("Enviando mensaje al servidor:", {
                        type: message.type,
                        data: message.data.slice(0, 20) + "...",
                        text: message.text,
                        timestamp: message.timestamp,
                        sender: message.sender,
                        function: message.function
                    });
                    ws.send(JSON.stringify(message));
                } else {
                    console.warn("WebSocket no está abierto, encolando mensaje");
                    queueMessageForSync(message);
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
                alert("Error al procesar el audio: " + err.message);
            };
            if (stream) {
                stream.getTracks().forEach(track => track.stop());
                stream = null;
            }
            audioChunks = [];
            mediaRecorder = null;
            if (supportsSpeechRecognition && recognition) {
                recognition.stop();
            }
        };

        mediaRecorder.onerror = function(err) {
            console.error("Error en MediaRecorder:", err);
            alert("Error durante la grabación: " + err.message);
        };

        try {
            mediaRecorder.start(100);
            console.log("Grabación iniciada");
            talkButton.classList.add("recording");
        } catch (err) {
            console.error("Error al iniciar la grabación:", err);
            alert("Error al iniciar la grabación: " + err.message);
            stream.getTracks().forEach(track => track.stop());
        }
    } else if (mediaRecorder.state === "recording") {
        mediaRecorder.stop();
        talkButton.classList.remove("recording");
    }
}

// Funciones de muteo
function toggleMute() {
    const muteButton = document.getElementById("mute");
    const groupMuteButton = document.getElementById("group-mute");
    if (muteButton.classList.contains("unmuted")) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "mute_all" }));
        }
        muteButton.classList.remove("unmuted");
        muteButton.classList.add("muted");
        if (groupMuteButton) {
            groupMuteButton.classList.remove("unmuted");
            groupMuteButton.classList.add("muted");
        }
    } else {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "unmute_all" }));
        }
        muteButton.classList.remove("muted");
        muteButton.classList.add("unmuted");
        if (groupMuteButton) {
            groupMuteButton.classList.remove("muted");
            groupMuteButton.classList.add("unmuted");
        }
    }
}

function toggleGroupMute() {
    const groupMuteButton = document.getElementById("group-mute");
    const muteButton = document.getElementById("mute");
    if (groupMuteButton.classList.contains("unmuted")) {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "mute_all" }));
        }
        groupMuteButton.classList.remove("unmuted");
        groupMuteButton.classList.add("muted");
        if (muteButton) {
            muteButton.classList.remove("unmuted");
            muteButton.classList.add("muted");
        }
    } else {
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "unmute_all" }));
        }
        groupMuteButton.classList.remove("muted");
        groupMuteButton.classList.add("unmuted");
        if (muteButton) {
            muteButton.classList.remove("muted");
            muteButton.classList.add("unmuted");
        }
    }
}

function updateMuteButton(isMuted) {
    const muteButton = document.getElementById("mute");
    const groupMuteButton = document.getElementById("group-mute");
    if (isMuted) {
        muteButton.classList.remove("unmuted");
        muteButton.classList.add("muted");
        if (groupMuteButton) {
            groupMuteButton.classList.remove("unmuted");
            groupMuteButton.classList.add("muted");
        }
    } else {
        muteButton.classList.remove("muted");
        muteButton.classList.add("unmuted");
        if (groupMuteButton) {
            groupMuteButton.classList.remove("muted");
            groupMuteButton.classList.add("unmuted");
        }
    }
}

function toggleMuteNonGroup() {
    const nonGroupMuteButton = document.getElementById("mute-non-group");
    const isMuting = !nonGroupMuteButton.classList.contains("muted");
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: isMuting ? "mute_non_group" : "unmute_non_group", group_id: currentGroup }));
    }
    if (isMuting) {
        nonGroupMuteButton.classList.add("muted");
        nonGroupMuteButton.textContent = "Desmutear no grupo";
    } else {
        nonGroupMuteButton.classList.remove("muted");
        nonGroupMuteButton.textContent = "Mutear no grupo";
    }
}

function toggleMuteUser(userId, button) {
    if (mutedUsers.has(userId)) {
        mutedUsers.delete(userId);
        button.textContent = "🔊";
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "unmute_user", target_user_id: userId }));
        }
        console.log(`Usuario ${userId} desmuteado`);
    } else {
        mutedUsers.add(userId);
        button.textContent = "🔇";
        if (ws && ws.readyState === WebSocket.OPEN) {
            ws.send(JSON.stringify({ type: "mute_user", target_user_id: userId }));
        }
        console.log(`Usuario ${userId} muteado`);
    }
}

// Funciones de usuarios
function updateUsers(count, list) {
    const usersDiv = document.getElementById('users');
    const groupUsersDiv = document.getElementById('group-users');
    if (!usersDiv || !groupUsersDiv) {
        console.error("Elementos #users o #group-users no encontrados en el DOM");
        return;
    }
    usersDiv.innerHTML = `Usuarios conectados: ${count}<br>`;
    groupUsersDiv.innerHTML = `Usuarios conectados: ${list.filter(user => user.group_id === currentGroup).length}<br>`;
    const userList = document.createElement("div");
    userList.className = "user-list";
    const groupUserList = document.createElement("div");
    groupUserList.className = "user-list";

    list.forEach(user => {
        const userDiv = document.createElement("div");
        userDiv.className = "user-item";
        if (user.group_id && user.group_id === currentGroup) {
            userDiv.classList.add('in-group');
        }
        const muteButton = document.createElement("button");
        muteButton.className = "mute-button";
        const isMuted = mutedUsers.has(user.user_id);
        muteButton.textContent = isMuted ? "🔇" : "🔊";
        muteButton.onclick = () => toggleMuteUser(user.user_id, muteButton);
        userDiv.appendChild(muteButton);
        const userText = document.createElement("span");
        let displayText = user.display;
        if (!displayText || displayText === user.user_id) {
            const parts = user.user_id.split('_');
            if (parts.length === 3) {
                const [, name, userFunction] = parts;
                displayText = `${name} (${userFunction})`;
            } else {
                displayText = user.user_id;
            }
        }
        userText.textContent = displayText;
        userDiv.appendChild(userText);
        userList.appendChild(userDiv);

        if (user.group_id === currentGroup) {
            const groupUserDiv = document.createElement("div");
            groupUserDiv.className = "user-item";
            const groupMuteButton = document.createElement("button");
            groupMuteButton.className = "mute-button";
            groupMuteButton.textContent = isMuted ? "🔇" : "🔊";
            groupMuteButton.onclick = () => toggleMuteUser(user.user_id, groupMuteButton);
            groupUserDiv.appendChild(groupMuteButton);
            const groupUserText = document.createElement("span");
            groupUserText.textContent = displayText;
            groupUserDiv.appendChild(groupUserText);
            groupUserList.appendChild(groupUserDiv);
        }
    });

    usersDiv.appendChild(userList);
    groupUsersDiv.appendChild(groupUserList);
    console.log("Lista de usuarios actualizada:", list);
}

// Funciones de grupos
function createGroup() {
    const groupId = document.getElementById('group-id').value.trim();
    const isPrivate = document.getElementById('group-private')?.checked || false;
    if (!groupId) {
        alert('Por favor, ingresa un nombre de grupo válido.');
        return;
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
        console.log("Enviando solicitud para crear grupo:", groupId, "Privado:", isPrivate);
        ws.send(JSON.stringify({ type: 'create_group', group_id: groupId, is_private: isPrivate }));
    } else {
        alert('No estás conectado al servidor. Intenta de nuevo.');
        console.error("WebSocket no está abierto. Estado:", ws ? ws.readyState : "WebSocket no definido");
    }
}

function joinGroup() {
    const groupId = document.getElementById('group-id').value.trim();
    const isPrivate = document.getElementById('group-private')?.checked || false;
    if (!groupId) {
        alert('Por favor, ingresa un nombre de grupo válido.');
        return;
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
        console.log("Enviando solicitud para unirse al grupo:", groupId, "Privado:", isPrivate);
        ws.send(JSON.stringify({ type: 'join_group', group_id: groupId, is_private: isPrivate }));
    } else {
        alert('No estás conectado al servidor. Intenta de nuevo.');
        console.error("WebSocket no está abierto. Estado:", ws ? ws.readyState : "WebSocket no definido");
    }
}

function leaveGroup() {
    if (ws && ws.readyState === WebSocket.OPEN && currentGroup) {
        ws.send(JSON.stringify({ type: 'leave_group', group_id: currentGroup }));
        currentGroup = null;
        localStorage.removeItem('groupId');
        document.getElementById('group-screen').style.display = 'none';
        document.getElementById('main').style.display = 'block';
        document.getElementById('group-chat-list').innerHTML = '';
        document.getElementById('group-flight-details').innerHTML = '';
        const logoutButton = document.getElementById('logout-button');
        if (logoutButton) logoutButton.style.display = 'block';
        updateSwipeHint();
        console.log("Grupo abandonado");
    }
}

function checkGroupStatus() {
    if (ws && ws.readyState === WebSocket.OPEN && currentGroup) {
        ws.send(JSON.stringify({ type: 'check_group', group_id: currentGroup }));
    }
}

function updateSwipeHint() {
    const swipeHint = document.getElementById('swipe-hint');
    const returnToGroupBtn = document.getElementById('return-to-group-btn');
    if (!swipeHint || !returnToGroupBtn) {
        console.error("Elemento #swipe-hint o #return-to-group-btn no encontrado en el DOM");
        return;
    }
    if (currentGroup) {
        if (document.getElementById('main').style.display === 'block') {
            swipeHint.style.display = 'block';
            swipeHint.textContent = 'Deslizá hacia la derecha para ir al grupo';
            returnToGroupBtn.style.display = 'block';
        } else if (document.getElementById('group-screen').style.display === 'block') {
            swipeHint.style.display = 'block';
            swipeHint.textContent = 'Deslizá hacia la izquierda para volver';
            returnToGroupBtn.style.display = 'none';
        }
    } else {
        swipeHint.style.display = 'none';
        returnToGroupBtn.style.display = 'none';
    }
}

function returnToGroup() {
    if (currentGroup) {
        document.getElementById('main').classList.add('slide-left');
        setTimeout(() => {
            document.getElementById('main').style.display = 'none';
            document.getElementById('group-screen').style.display = 'block';
            document.getElementById('main').classList.remove('slide-left');
            updateSwipeHint();
        }, 300);
    }
}

function backToMainFromGroup() {
    document.getElementById('group-screen').classList.add('slide-right');
    setTimeout(() => {
        document.getElementById('group-screen').style.display = 'none';
        document.getElementById('main').style.display = 'block';
        document.getElementById('group-screen').classList.remove('slide-right');
        const logoutButton = document.getElementById('logout-button');
        if (logoutButton) logoutButton.style.display = 'block';
        checkGroupStatus();
        updateSwipeHint();
    }, 300);
}

let groupRecording = false;
let groupMediaRecorder = null;

function toggleGroupTalk() {
    const talkButton = document.getElementById('group-talk');
    if (!talkButton) {
        console.error("Botón #group-talk no encontrado en el DOM");
        return;
    }
    if (!groupRecording) {
        navigator.mediaDevices.getUserMedia({ audio: true })
            .then(stream => {
                groupMediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm' });
                const chunks = [];
                groupMediaRecorder.ondataavailable = e => {
                    if (e.data.size > 0) chunks.push(e.data);
                };
                groupMediaRecorder.onstop = () => {
                    const blob = new Blob(chunks, { type: 'audio/webm' });
                    if (blob.size === 0) {
                        console.error("Blob de grupo vacío");
                        alert("El audio grabado está vacío. Verifica tu micrófono.");
                        return;
                    }
                    const reader = new FileReader();
                    reader.onload = () => {
                        const audioData = reader.result.split(',')[1];
                        sendGroupMessage(audioData);
                    };
                    reader.readAsDataURL(blob);
                    stream.getTracks().forEach(track => track.stop());
                };
                groupMediaRecorder.start(100);
                groupRecording = true;
                talkButton.classList.add("recording");
                console.log("Grabación de grupo iniciada");
            })
            .catch(err => {
                console.error('Error al acceder al micrófono:', err);
                alert('No se pudo acceder al micrófono. Por favor, verifica los permisos de la app.');
            });
    } else {
        groupMediaRecorder.stop();
        groupRecording = false;
        talkButton.classList.remove("recording");
        console.log("Grabación de grupo detenida");
    }
}

function sendGroupMessage(audioData) {
    const timestamp = new Date().toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
    const message = {
        type: 'group_message',
        data: audioData,
        sender: localStorage.getItem('userName') || "Anónimo",
        function: localStorage.getItem('userFunction') || "Desconocida",
        timestamp: timestamp,
        text: supportsSpeechRecognition ? "Procesando..." : "Procesando...",
        sessionToken: localStorage.getItem("sessionToken"),
        group_id: currentGroup
    };

    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify(message));
        console.log("Mensaje de grupo enviado:", {
            type: message.type,
            data: message.data.slice(0, 20) + "...",
            text: message.text,
            timestamp: message.timestamp,
            sender: message.sender,
            function: message.function,
            group_id: message.group_id
        });
    } else {
        console.warn("WebSocket no está abierto, encolando mensaje de grupo");
        queueMessageForSync(message);
    }
}

// Funciones de navegación
function showGroupRadar() {
    console.log("Mostrando radar desde grupo...");
    document.getElementById('group-screen').style.display = 'none';
    document.getElementById('radar-screen').style.display = 'block';
    const logoutButton = document.getElementById('logout-button');
    if (logoutButton) logoutButton.style.display = 'none';
    if (!map) {
        initMap();
        updateOpenSkyData();
    } else {
        map.invalidateSize();
        filterFlights();
    }
}

function showGroupHistory() {
    document.getElementById('group-screen').style.display = 'none';
    document.getElementById('history-screen').style.display = 'block';
    loadHistory();
}

function showRadar() {
    console.log("Mostrando radar...");
    document.getElementById("main").style.display = "none";
    document.getElementById("radar-screen").style.display = "block";
    const logoutButton = document.getElementById('logout-button');
    if (logoutButton) logoutButton.style.display = 'none';
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
    const logoutButton = document.getElementById('logout-button');
    if (logoutButton) logoutButton.style.display = 'block';
    document.getElementById("search-bar").value = "";
    filterFlights();
    updateSwipeHint();
}

function showHistory() {
    fetch('/history')
        .then(response => {
            if (!response.ok) {
                throw new Error(`Error al cargar historial: ${response.status}`);
            }
            return response.json();
        })
        .then(data => {
            const historyList = document.getElementById("history-list");
            if (!historyList) {
                console.error("Elemento #history-list no encontrado en el DOM");
                return;
            }
            historyList.innerHTML = "";
            data.forEach(msg => {
                const msgDiv = document.createElement("div");
                msgDiv.className = "chat-message";
                const utcTime = msg.timestamp.split(":");
                const utcDate = new Date();
                utcDate.setUTCHours(parseInt(utcTime[0]), parseInt(utcTime[1]));
                const localTime = utcDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
                const text = msg.text || "Sin transcripción";
                msgDiv.innerHTML = `<span class="play-icon">▶️</span> ${msg.date} ${localTime} - ${msg.user_id}: ${text}`;
                const audioBlob = base64ToBlob(msg.audio, 'audio/webm');
                if (audioBlob) {
                    msgDiv.onclick = () => playAudio(audioBlob);
                } else {
                    console.error("No se pudo crear Blob para mensaje del historial:", msg);
                }
                historyList.appendChild(msgDiv);
            });
            document.getElementById("main").style.display = "none";
            document.getElementById("radar-screen").style.display = "none";
            document.getElementById("history-screen").style.display = "block";
            const logoutButton = document.getElementById('logout-button');
            if (logoutButton) logoutButton.style.display = 'none';
            console.log("Historial cargado con", data.length, "mensajes");
        })
        .catch(err => {
            console.error("Error al cargar historial:", err);
            const historyList = document.getElementById("history-list");
            if (historyList) {
                historyList.innerHTML = "<div>Error al cargar el historial</div>";
            }
        });
}

function backToMain() {
    document.getElementById("history-screen").style.display = "none";
    document.getElementById("main").style.display = "block";
    const logoutButton = document.getElementById('logout-button');
    if (logoutButton) logoutButton.style.display = 'block';
    updateSwipeHint();
    console.log("Volviendo a la pantalla principal desde historial");
}

// Funciones auxiliares
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

function logout() {
    console.log("Iniciando cierre de sesión...");
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: "logout" }));
    } else {
        completeLogout();
    }
}

function completeLogout() {
    console.log("Completando cierre de sesión...");
    if (ws) {
        ws.close();
        ws = null;
    }
    if (stream) {
        stream.getTracks().forEach(track => track.stop());
        stream = null;
    }
    if (groupMediaRecorder) {
        groupMediaRecorder.stop();
        groupMediaRecorder = null;
    }
    localStorage.removeItem("sessionToken");
    localStorage.removeItem("userName");
    localStorage.removeItem("userFunction");
    localStorage.removeItem("userLegajo");
    localStorage.removeItem("groupId");
    localStorage.removeItem("lastSearchQuery");
    currentGroup = null;
    mutedUsers.clear();
    clearInterval(reconnectInterval);
    stopPing();
    document.getElementById("register").style.display = "block";
    document.getElementById("main").style.display = "none";
    document.getElementById("group-screen").style.display = "none";
    document.getElementById("radar-screen").style.display = "none";
    document.getElementById("history-screen").style.display = "none";
    console.log("Sesión cerrada completamente");
}

// Funciones de notificaciones
function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
        fetch('/templates/sw.js', { method: 'HEAD' })
            .then(response => {
                if (response.ok) {
                    navigator.serviceWorker.register('/templates/sw.js')
                        .then(() => console.log('Service Worker registrado'))
                        .catch(err => console.error('Error al registrar Service Worker:', err));
                } else {
                    console.warn('Archivo sw.js no encontrado.');
                }
            })
            .catch(err => {
                console.warn('No se pudo verificar sw.js:', err);
            });
    } else {
        console.warn('Service Worker no soportado.');
    }
}

function subscribeToPush() {
    // Comentar hasta configurar VAPID
    /*
    if ('serviceWorker' in navigator && 'PushManager' in window) {
        navigator.serviceWorker.ready.then(registration => {
            registration.pushManager.subscribe({
                userVisibleOnly: true,
                applicationServerKey: urlBase64ToUint8Array('YOUR_PUBLIC_VAPID_KEY')
            }).then(subscription => {
                console.log("Suscripción a push exitosa:", subscription);
                fetch('/subscribe', {
                    method: 'POST',
                    body: JSON.stringify(subscription),
                    headers: {
                        'Content-Type': 'application/json'
                    }
                }).catch(err => {
                    console.error("Error al enviar suscripción al servidor:", err);
                });
            }).catch(err => {
                console.error("Error al suscribirse a push:", err);
            });
        }).catch(err => {
            console.error("Error al obtener el Service Worker:", err);
        });
    } else {
        console.warn('Notificaciones push no soportadas.');
    }
    */
}

function urlBase64ToUint8Array(base64String) {
    try {
        const padding = '='.repeat((4 - base64String.length % 4) % 4);
        const base64 = (base64String + padding).replace(/-/g, '+').replace(/_/g, '/');
        const rawData = window.atob(base64);
        const outputArray = new Uint8Array(rawData.length);
        for (let i = 0; i < rawData.length; ++i) {
            outputArray[i] = rawData.charCodeAt(i);
        }
        return outputArray;
    } catch (err) {
        console.error("Error al convertir Base64 a Uint8Array:", err);
        throw err;
    }
}

// Event listeners
document.addEventListener('click', unlockAudio, { once: true });

let lastVolumeUpTime = 0;
let volumeUpCount = 0;

document.addEventListener('keydown', (event) => {
    if (event.key === 'VolumeUp') {
        event.preventDefault();
        const currentTime = Date.now();
        const timeDiff = currentTime - lastVolumeUpTime;

        if (timeDiff < 500) {
            volumeUpCount++;
            if (volumeUpCount === 2) {
                toggleTalk();
                volumeUpCount = 0;
            }
        } else {
            volumeUpCount = 1;
        }
        lastVolumeUpTime = currentTime;
    }
});

document.addEventListener('touchstart', e => {
    if (!isSwiping) {
        startX = e.touches[0].clientX;
    }
});

document.addEventListener('touchmove', e => {
    if (!isSwiping) {
        currentX = e.touches[0].clientX;
    }
});

document.addEventListener('touchend', e => {
    if (isSwiping) return;
    const deltaX = currentX - startX;
    if (Math.abs(deltaX) > 50) {
        if (deltaX > 0 && document.getElementById('group-screen').style.display === 'block') {
            backToMainFromGroup();
        } else if (deltaX < 0 && document.getElementById('main').style.display === 'block' && currentGroup) {
            returnToGroup();
        }
    }
});

// Verificar permisos de notificación
function checkNotificationPermission() {
    if ('Notification' in window) {
        if (Notification.permission === 'granted') {
            console.log('Permiso de notificación ya concedido');
            subscribeToPush();
        } else if (Notification.permission !== 'denied') {
            Notification.requestPermission().then(permission => {
                if (permission === 'granted') {
                    console.log('Permiso de notificación concedido');
                    subscribeToPush();
                } else {
                    console.warn('Permiso de notificación denegado');
                }
            }).catch(err => {
                console.error('Error al solicitar permiso de notificación:', err);
            });
        } else {
            console.warn('Permiso de notificación denegado previamente');
        }
    } else {
        console.warn('Notificaciones no soportadas en este navegador');
    }
}

// Función para cargar historial
function loadHistory() {
    fetch('/history')
        .then(response => {
            if (!response.ok) {
                throw new Error(`Error al cargar historial: ${response.status}`);
            }
            return response.json();
        })
        .then(data => {
            const historyList = document.getElementById("history-list");
            if (!historyList) {
                console.error("Elemento #history-list no encontrado en el DOM");
                return;
            }
            historyList.innerHTML = "";
            data.forEach(msg => {
                const msgDiv = document.createElement("div");
                msgDiv.className = "chat-message";
                const utcTime = msg.timestamp.split(":");
                const utcDate = new Date();
                utcDate.setUTCHours(parseInt(utcTime[0]), parseInt(utcTime[1]));
                const localTime = utcDate.toLocaleTimeString([], { hour: '2-digit', minute: '2-digit', hour12: false });
                const text = msg.text || "Sin transcripción";
                msgDiv.innerHTML = `<span class="play-icon">▶️</span> ${msg.date} ${localTime} - ${msg.user_id}: ${text}`;
                const audioBlob = base64ToBlob(msg.audio, 'audio/webm');
                if (audioBlob) {
                    msgDiv.onclick = () => playAudio(audioBlob);
                } else {
                    console.error("No se pudo crear Blob para mensaje del historial:", msg);
                }
                historyList.appendChild(msgDiv);
            });
            console.log("Historial cargado con", data.length, "mensajes");
        })
        .catch(err => {
            console.error("Error al cargar historial:", err);
            const historyList = document.getElementById("history-list");
            if (historyList) {
                historyList.innerHTML = "<div>Error al cargar el historial</div>";
            }
        });
}
