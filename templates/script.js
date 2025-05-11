let ws = null;
let userId = null;
let currentGroup = null;
let isRecording = false;
let isGroupRecording = false;
let isMuted = false;
let isGroupMuted = false;
let isNonGroupMuted = false;
let mediaRecorder = null;
let audioChunks = [];
let flightData = [];
let map = null;
let markers = [];
let isSwiping = false;
let startX = 0;
let currentX = 0;
let updatesEnabled = true;
let departureAnnouncementsEnabled = false;
let announcementsEnabled = false;
let restrictTokens = JSON.parse(localStorage.getItem('restrictTokens') || 'true');
let dailyTokenCount = parseInt(localStorage.getItem('dailyTokenCount') || '0', 10);
const MAX_TOKENS_DAILY = 2000;
const TOKENS_PER_FLIGHT = 1;
const MAX_FLIGHTS_PER_REQUEST = 20;
const AIRPORT_MAPPING = {
    'SABE': 'Aeroparque',
    'SAEZ': 'Ezeiza',
    // Agrega más mapeos según sea necesario
};

function showError(message) {
    const errorDiv = document.getElementById('error-message');
    if (errorDiv) {
        errorDiv.textContent = message;
        errorDiv.style.display = 'block';
        setTimeout(() => { errorDiv.style.display = 'none'; }, 5000);
    }
    console.error(message);
}

async function loginUser(event) {
    event.preventDefault();
    const surname = document.getElementById('surname-login')?.value.trim() || '';
    const employee_id = document.getElementById('employee_id-login')?.value.trim() || '';
    const password = document.getElementById('password-login')?.value || '';
    console.log("Intentando login con:", { surname, employee_id });
    if (!surname || !employee_id || !password) {
        showError('Por favor, completa todos los campos.');
        return;
    }
    if (!/^\d{5}$/.test(employee_id)) {
        showError('El legajo debe contener exactamente 5 números.');
        return;
    }
    try {
        const response = await fetch('/login', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ surname, employee_id, password }),
        });
        const data = await response.json();
        console.log("Respuesta de /login:", response.status, data);
        if (response.ok) {
            localStorage.setItem('sessionToken', data.token);
            const decoded = atob(data.token);
            const [emp_id, surn, sector] = decoded.split('_');
            localStorage.setItem('userName', surn);
            localStorage.setItem('userFunction', sector);
            localStorage.setItem('userLegajo', emp_id);
            userId = `${emp_id}_${surn}_${sector}`;
            connectWebSocket(data.token);
            document.getElementById('auth-section').style.display = 'none';
            document.getElementById('main').style.display = 'block';
            displayUserProfile();
            updateOpenSkyData();
        } else {
            const errorMessage = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail || 'Error desconocido');
            showError(`Error al iniciar sesión: ${errorMessage}`);
        }
    } catch (error) {
        showError('Error de conexión con el servidor.');
        console.error('Error al iniciar sesión:', error);
    }
}

async function registerUser(event) {
    event.preventDefault();
    const surname = document.getElementById('surname')?.value.trim() || '';
    const employee_id = document.getElementById('employee_id')?.value.trim() || '';
    const sector = document.getElementById('sector')?.value || '';
    const password = document.getElementById('password')?.value || '';
    console.log("Intentando registro con:", { surname, employee_id, sector });
    if (!surname || !employee_id || !sector || !password) {
        showError('Por favor, completa todos los campos.');
        return;
    }
    if (!/^\d{5}$/.test(employee_id)) {
        showError('El legajo debe contener exactamente 5 números.');
        return;
    }
    try {
        const response = await fetch('/register', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ surname, employee_id, sector, password }),
        });
        const data = await response.json();
        console.log("Respuesta de /register:", response.status, data);
        if (response.ok) {
            showError('Registro exitoso. Por favor, inicia sesión.');
            document.getElementById('register-form').style.display = 'none';
            document.getElementById('login-form').style.display = 'block';
        } else {
            const errorMessage = typeof data.detail === 'string' ? data.detail : JSON.stringify(data.detail || 'Error desconocido');
            showError(`Error al registrarse: ${errorMessage}`);
        }
    } catch (error) {
        showError('Error de conexión con el servidor.');
        console.error('Error al registrarse:', error);
    }
}

function connectWebSocket(token) {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.close();
    }
    ws = new WebSocket(`wss://${window.location.host}/ws/${token}`);
    ws.onopen = () => {
        console.log("WebSocket conectado");
        startPing();
    };
    ws.onmessage = (event) => {
        try {
            const data = JSON.parse(event.data);
            console.log("Mensaje WebSocket:", data);
            if (data.type === 'message' || data.type === 'group_message') {
                displayMessage(data);
                if (data.audio) {
                    playAudio(data.audio, data.sender, data.type === 'group_message' ? data.group_id : null);
                }
            } else if (data.type === 'user_list') {
                updateUserList(data.users);
            } else if (data.type === 'group_joined') {
                currentGroup = data.group_id;
                document.getElementById('main').style.display = 'none';
                document.getElementById('group-screen').style.display = 'block';
                updateSwipeHint();
                updateFlightInfo();
            } else if (data.type === 'group_left') {
                currentGroup = null;
                document.getElementById('group-screen').style.display = 'none';
                document.getElementById('main').style.display = 'block';
                updateSwipeHint();
            } else if (data.type === 'error') {
                showError(data.message);
                if (data.message.includes('Token no registrado') || data.message.includes('Sesión inválida')) {
                    completeLogout();
                }
            } else if (data.type === 'flight_update') {
                flightData = data.flights.filter(f => f && f.flight_number);
                updateFlightInfo();
                updateMap();
            }
        } catch (err) {
            console.error("Error al procesar mensaje WebSocket:", err);
        }
    };
    ws.onclose = () => {
        console.log("WebSocket cerrado");
        stopPing();
        setTimeout(() => connectWebSocket(token), 5000);
    };
    ws.onerror = (error) => {
        console.error("Error en WebSocket:", error);
    };
}

function startPing() {
    if (!ws || ws.readyState !== WebSocket.OPEN) return;
    ws.send(JSON.stringify({ type: 'ping' }));
    setTimeout(startPing, 30000);
}

function stopPing() {
    // No se necesita implementación explícita para detener pings
}

function displayUserProfile() {
    const profileDiv = document.getElementById('user-profile');
    if (profileDiv) {
        const name = localStorage.getItem('userName') || 'Usuario';
        const role = localStorage.getItem('userFunction') || 'Rol desconocido';
        profileDiv.textContent = `Usuario: ${name} | Rol: ${role}`;
    }
}

function updateUserList(users) {
    const usersDiv = document.getElementById('users');
    const groupUsersDiv = document.getElementById('group-users');
    if (usersDiv) {
        usersDiv.textContent = `Usuarios conectados: ${users.length}`;
    }
    if (groupUsersDiv && currentGroup) {
        groupUsersDiv.textContent = `Usuarios conectados: ${users.filter(u => u.group_id === currentGroup).length}`;
    }
}

function displayMessage(data) {
    const chatList = data.type === 'group_message' ? document.getElementById('group-chat-list') : document.getElementById('chat-list');
    if (!chatList) return;
    const messageDiv = document.createElement('div');
    messageDiv.className = 'chat-message';
    messageDiv.innerHTML = `<span class="play-icon">▶</span>${data.sender}: ${data.text || 'Audio'}`;
    messageDiv.onclick = () => {
        if (data.audio) {
            playAudio(data.audio, data.sender, data.type === 'group_message' ? data.group_id : null);
        }
    };
    chatList.appendChild(messageDiv);
    chatList.scrollTop = chatList.scrollHeight;
}

async function playAudio(audioData, sender, groupId) {
    try {
        const audioBlob = base64ToBlob(audioData, 'audio/webm');
        if (!audioBlob) throw new Error("No se pudo convertir el audio");
        const audioUrl = URL.createObjectURL(audioBlob);
        const audio = new Audio(audioUrl);
        audio.play();
        if ('mediaSession' in navigator && typeof MediaSessionMetadata !== 'undefined') {
            navigator.mediaSession.metadata = new MediaSessionMetadata({
                title: `Mensaje de ${sender}`,
                artist: groupId ? `Grupo ${groupId}` : 'HandyHandle',
                album: 'Comunicación Aeronáutica'
            });
        }
        audio.onended = () => URL.revokeObjectURL(audioUrl);
    } catch (err) {
        console.error("Error al reproducir audio:", err);
        showError("Error al reproducir el mensaje de audio.");
    }
}

async function toggleTalk() {
    const talkButton = document.getElementById('talk');
    if (!talkButton) return;
    if (!isRecording) {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaRecorder = new MediaRecorder(stream);
            audioChunks = [];
            mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
            mediaRecorder.onstop = async () => {
                const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
                const reader = new FileReader();
                reader.readAsDataURL(audioBlob);
                reader.onloadend = () => {
                    const base64Audio = reader.result.split(',')[1];
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'message',
                            audio: base64Audio,
                            sender: userId,
                            text: 'Mensaje de voz'
                        }));
                    } else {
                        navigator.serviceWorker.controller?.postMessage({
                            type: 'QUEUE_MESSAGE',
                            message: {
                                type: 'message',
                                audio: base64Audio,
                                sender: userId,
                                text: 'Mensaje de voz'
                            }
                        });
                    }
                };
                stream.getTracks().forEach(track => track.stop());
            };
            mediaRecorder.start();
            isRecording = true;
            talkButton.classList.add('recording');
        } catch (err) {
            showError("Error al acceder al micrófono.");
            console.error("Error al grabar:", err);
        }
    } else {
        mediaRecorder.stop();
        isRecording = false;
        talkButton.classList.remove('recording');
    }
}

async function toggleGroupTalk() {
    const groupTalkButton = document.getElementById('group-talk');
    if (!groupTalkButton || !currentGroup) return;
    if (!isGroupRecording) {
        try {
            const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
            mediaRecorder = new MediaRecorder(stream);
            audioChunks = [];
            mediaRecorder.ondataavailable = e => audioChunks.push(e.data);
            mediaRecorder.onstop = async () => {
                const audioBlob = new Blob(audioChunks, { type: 'audio/webm' });
                const reader = new FileReader();
                reader.readAsDataURL(audioBlob);
                reader.onloadend = () => {
                    const base64Audio = reader.result.split(',')[1];
                    if (ws && ws.readyState === WebSocket.OPEN) {
                        ws.send(JSON.stringify({
                            type: 'group_message',
                            group_id: currentGroup,
                            audio: base64Audio,
                            sender: userId,
                            text: 'Mensaje de voz'
                        }));
                    } else {
                        navigator.serviceWorker.controller?.postMessage({
                            type: 'QUEUE_MESSAGE',
                            message: {
                                type: 'group_message',
                                group_id: currentGroup,
                                audio: base64Audio,
                                sender: userId,
                                text: 'Mensaje de voz'
                            }
                        });
                    }
                };
                stream.getTracks().forEach(track => track.stop());
            };
            mediaRecorder.start();
            isGroupRecording = true;
            groupTalkButton.classList.add('recording');
        } catch (err) {
            showError("Error al acceder al micrófono.");
            console.error("Error al grabar en grupo:", err);
        }
    } else {
        mediaRecorder.stop();
        isGroupRecording = false;
        groupTalkButton.classList.remove('recording');
    }
}

function toggleMute() {
    const muteButton = document.getElementById('mute');
    if (!muteButton) return;
    isMuted = !isMuted;
    muteButton.classList.toggle('muted', isMuted);
    muteButton.classList.toggle('unmuted', !isMuted);
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'mute', muted: isMuted }));
    }
}

function toggleGroupMute() {
    const groupMuteButton = document.getElementById('group-mute');
    if (!groupMuteButton) return;
    isGroupMuted = !isGroupMuted;
    groupMuteButton.classList.toggle('muted', isGroupMuted);
    groupMuteButton.classList.toggle('unmuted', !isGroupMuted);
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'group_mute', group_id: currentGroup, muted: isGroupMuted }));
    }
}

function toggleMuteNonGroup() {
    const muteNonGroupButton = document.getElementById('mute-non-group');
    if (!muteNonGroupButton) return;
    isNonGroupMuted = !isNonGroupMuted;
    muteNonGroupButton.classList.toggle('muted', isNonGroupMuted);
    muteNonGroupButton.classList.toggle('unmuted', !isNonGroupMuted);
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'mute_non_group', muted: isNonGroupMuted }));
    }
}

function joinGroup() {
    const groupId = document.getElementById('group-id')?.value.trim();
    const isPrivate = document.getElementById('group-private')?.checked;
    if (!groupId) {
        showError("Por favor, ingresa un nombre de grupo.");
        return;
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'join_group',
            group_id: groupId,
            private: isPrivate,
            sessionToken: localStorage.getItem('sessionToken')
        }));
    } else {
        showError("No hay conexión WebSocket. Intenta de nuevo.");
    }
}

function createGroup() {
    const groupId = document.getElementById('group-id')?.value.trim();
    const isPrivate = document.getElementById('group-private')?.checked;
    if (!groupId) {
        showError("Por favor, ingresa un nombre de grupo.");
        return;
    }
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'create_group',
            group_id: groupId,
            private: isPrivate,
            sessionToken: localStorage.getItem('sessionToken')
        }));
    } else {
        showError("No hay conexión WebSocket. Intenta de nuevo.");
    }
}

function leaveGroup() {
    if (currentGroup && ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({
            type: 'leave_group',
            group_id: currentGroup,
            sessionToken: localStorage.getItem('sessionToken')
        }));
    }
}

function showRadar() {
    document.getElementById('main').style.display = 'none';
    document.getElementById('radar-screen').style.display = 'block';
    if (!map) {
        initMap();
    }
    updateMap();
}

function showGroupRadar() {
    document.getElementById('group-screen').style.display = 'none';
    document.getElementById('radar-screen').style.display = 'block';
    if (!map) {
        initMap();
    }
    updateMap();
}

function backToMainFromRadar() {
    document.getElementById('radar-screen').style.display = 'none';
    document.getElementById('main').style.display = 'block';
    updateSwipeHint();
}

function backToMainFromGroup() {
    document.getElementById('group-screen').style.display = 'none';
    document.getElementById('main').style.display = 'block';
    updateSwipeHint();
}

function showHistory() {
    document.getElementById('main').style.display = 'none';
    document.getElementById('history-screen').style.display = 'block';
    // Implementar lógica para cargar historial
}

function showGroupHistory() {
    document.getElementById('group-screen').style.display = 'none';
    document.getElementById('history-screen').style.display = 'block';
    // Implementar lógica para cargar historial
}

function showFlightDetails(flight) {
    const modal = document.getElementById('flight-details-modal');
    const content = document.getElementById('flight-details-content');
    if (!modal || !content) return;
    content.innerHTML = `
        <p><b>Número de Vuelo:</b> ${flight.flight_number || 'N/A'}</p>
        <p><b>Matrícula:</b> ${flight.registration || 'N/A'}</p>
        <p><b>Origen:</b> ${AIRPORT_MAPPING[flight.origin] || flight.origin || 'N/A'}</p>
        <p><b>Destino:</b> ${AIRPORT_MAPPING[flight.destination] || flight.destination || 'N/A'}</p>
        <p><b>Hora Programada:</b> ${flight.sta ? new Date(flight.sta).toLocaleString() : 'N/A'}</p>
        <p><b>Hora Estimada:</b> ${flight.eta ? new Date(flight.eta).toLocaleString() : 'N/A'}</p>
        <p><b>Estado:</b> ${flight.status || 'N/A'}</p>
    `;
    modal.style.display = 'block';
}

function closeFlightDetails() {
    const modal = document.getElementById('flight-details-modal');
    if (modal) modal.style.display = 'none';
}

async function updateOpenSkyData() {
    if (!updatesEnabled) {
        console.log("Actualizaciones pausadas");
        setTimeout(updateOpenSkyData, 15000);
        return;
    }
    if (restrictTokens && dailyTokenCount >= MAX_TOKENS_DAILY) {
        console.warn("Límite de tokens alcanzado:", dailyTokenCount);
        showError("Límite diario de " + MAX_TOKENS_DAILY + " tokens alcanzado.");
        return;
    }
    try {
        const token = localStorage.getItem('sessionToken');
        if (!token) {
            showError("Sesión no válida. Por favor, inicia sesión nuevamente.");
            completeLogout();
            return;
        }
        const response = await fetch(`/api/flights?limit=${MAX_FLIGHTS_PER_REQUEST}`, {
            headers: {
                'Authorization': `Bearer ${token}`,
                'Content-Type': 'application/json'
            }
        });
        console.log("Respuesta de /api/flights:", response.status, response.statusText);
        if (response.ok) {
            const data = await response.json();
            console.log("Datos de /api/flights:", JSON.stringify(data, null, 2));
            flightData = Array.isArray(data.flights) ? data.flights.filter(f => f && f.flight_number) : [];
            console.log("flightData filtrado:", flightData);
            dailyTokenCount += flightData.length * TOKENS_PER_FLIGHT;
            localStorage.setItem('dailyTokenCount', dailyTokenCount.toString());
            updateFlightInfo();
            updateMap();
            // Verificar anuncios de llegadas y despegues
            if (announcementsEnabled || departureAnnouncementsEnabled) {
                flightData.forEach(flight => {
                    if (flight.status === 'Landed' && flight.destination === 'SABE' && announcementsEnabled) {
                        announceFlight(flight, 'llegada');
                    } else if (flight.status === 'Departed' && flight.origin === 'SABE' && departureAnnouncementsEnabled) {
                        announceFlight(flight, 'despegue');
                    }
                });
            }
        } else if (response.status === 401) {
            showError("Sesión expirada. Por favor, inicia sesión nuevamente.");
            completeLogout();
        } else {
            throw new Error(`Error ${response.status}: ${response.statusText}`);
        }
    } catch (err) {
        showError("Error al cargar datos de vuelos: " + err.message);
        console.error("Error al cargar vuelos:", err);
        const tables = ['departures-table', 'arrivals-table', 'group-departures-table', 'group-arrivals-table'];
        tables.forEach(id => {
            const table = document.getElementById(id);
            if (table) table.innerHTML = "<tr><td colspan='7'>Error al cargar datos</td></tr>";
        });
    }
    setTimeout(updateOpenSkyData, 15000);
}

function announceFlight(flight, type) {
    const message = type === 'llegada' 
        ? `El vuelo ${flight.flight_number} con origen en ${AIRPORT_MAPPING[flight.origin] || flight.origin} ha aterrizado en Aeroparque.`
        : `El vuelo ${flight.flight_number} con destino a ${AIRPORT_MAPPING[flight.destination] || flight.destination} ha despegado de Aeroparque.`;
    if ('speechSynthesis' in window) {
        const utterance = new SpeechSynthesisUtterance(message);
        utterance.lang = 'es-ES';
        speechSynthesis.speak(utterance);
    }
    showNotification('Anuncio de Vuelo', { body: message });
}

function initMap() {
    console.log("Inicializando mapa...");
    const mapContainer = document.getElementById('map');
    if (!mapContainer) {
        console.error("Contenedor #map no encontrado");
        showError("No se puede cargar el mapa: contenedor no encontrado.");
        return;
    }
    if (typeof L === 'undefined') {
        console.error("Leaflet no está definido");
        showError("Error al cargar el mapa: Leaflet no disponible.");
        return;
    }
    try {
        map = L.map('map').setView([-34.5597, -58.4116], 10);
        L.tileLayer('https://{s}.tile.openstreetmap.org/{z}/{x}/{y}.png', {
            maxZoom: 19,
            attribution: '© OpenStreetMap'
        }).addTo(map);
        const aeroparqueIcon = L.icon({
            iconUrl: '/templates/airport.png',
            iconSize: [30, 30]
        });
        L.marker([-34.5597, -58.4116], { icon: aeroparqueIcon })
            .addTo(map)
            .bindPopup("Aeroparque");
        map.invalidateSize();
        console.log("Mapa inicializado");
    } catch (err) {
        console.error("Error al inicializar Leaflet:", err);
        showError("Error al inicializar el mapa.");
    }
}

function updateMap() {
    if (!map) {
        console.warn("Mapa no inicializado. Intentando inicializar...");
        initMap();
        if (!map) return;
    }
    console.log("Actualizando mapa con flightData:", flightData);
    markers.forEach(marker => map.removeLayer(marker));
    markers = [];
    const validFlights = flightData.filter(f => f && f.lat && f.lon && f.flight_number && f.flight_number.startsWith('AR'));
    console.log("Vuelos válidos para el mapa:", validFlights);
    validFlights.forEach(flight => {
        try {
            const airplaneIcon = L.icon({
                iconUrl: '/templates/airplane.png',
                iconSize: [30, 30],
                iconAnchor: [15, 15],
                popupAnchor: [0, -15]
            });
            const marker = L.marker([flight.lat, flight.lon], {
                icon: airplaneIcon,
                rotationAngle: flight.heading || 0
            }).bindPopup(`
                <b>Vuelo:</b> ${flight.flight_number}<br>
                <b>Matrícula:</b> ${flight.registration || 'N/A'}<br>
                <b>Estado:</b> ${flight.status || 'N/A'}<br>
                <b>Origen:</b> ${AIRPORT_MAPPING[flight.origin] || flight.origin || 'N/A'}<br>
                <b>Destino:</b> ${AIRPORT_MAPPING[flight.destination] || flight.destination || 'N/A'}<br>
                <b>ETA:</b> ${flight.eta ? new Date(flight.eta).toLocaleTimeString() : 'N/A'}
            `);
            marker.flight = flight;
            markers.push(marker);
            marker.addTo(map);
        } catch (err) {
            console.error("Error al agregar marcador para vuelo:", flight, err);
        }
    });
    filterFlights(localStorage.getItem('lastSearchQuery') || '');
    map.invalidateSize();
    console.log("Mapa actualizado con", markers.length, "marcadores");
}

function updateFlightInfo() {
    console.log("Actualizando tablas con flightData:", flightData);
    const tables = {
        'departures-table': { filter: f => f.origin === 'SABE', isArrival: false },
        'arrivals-table': { filter: f => f.destination === 'SABE', isArrival: true },
        'group-departures-table': { filter: f => f.origin === 'SABE', isArrival: false },
        'group-arrivals-table': { filter: f => f.destination === 'SABE', isArrival: true }
    };
    Object.entries(tables).forEach(([id, { filter, isArrival }]) => {
        const table = document.getElementById(id);
        if (!table) {
            console.error(`Tabla #${id} no encontrada`);
            return;
        }
        const tbody = table.querySelector('tbody') || table;
        tbody.innerHTML = '';
        const flights = flightData.filter(f => f && f.flight_number && f.flight_number.startsWith('AR') && filter(f));
        console.log(`Vuelos para ${id}:`, flights);
        flights.forEach(flight => {
            const row = document.createElement('tr');
            row.className = 'tams-row';
            const sta = flight.sta ? new Date(flight.sta).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'N/A';
            const eta = flight.eta ? new Date(flight.eta).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' }) : 'N/A';
            const originDest = isArrival ? (AIRPORT_MAPPING[flight.origin] || flight.origin || 'N/A') : (AIRPORT_MAPPING[flight.destination] || flight.destination || 'N/A');
            row.innerHTML = `
                <td>${flight.registration || 'N/A'}</td>
                <td>${flight.flight_number || 'N/A'}</td>
                <td>${sta}</td>
                <td>${flight.position || 'N/A'}</td>
                <td>${originDest}</td>
                <td>${eta}</td>
                <td><button class="tams-details-btn" onclick="showFlightDetails(${JSON.stringify(flight).replace(/"/g, '"')})">Ver Más</button></td>
            `;
            tbody.appendChild(row);
        });
    });
    filterFlights(localStorage.getItem('lastSearchQuery') || '');
}

function filterFlights(searchTerm = '') {
    searchTerm = searchTerm.toUpperCase().trim();
    console.log("Filtrando vuelos con término:", searchTerm);
    const tables = ['departures-table', 'arrivals-table', 'group-departures-table', 'group-arrivals-table'];
    tables.forEach(id => {
        const table = document.getElementById(id);
        if (!table) return;
        const rows = table.querySelectorAll('tr.tams-row');
        console.log(`Filtrando ${rows.length} filas en ${id}`);
        rows.forEach(row => {
            const registration = row.cells[0].textContent.toUpperCase();
            const flightNumber = row.cells[1].textContent.toUpperCase();
            const matches = searchTerm === '' || registration.includes(searchTerm) || flightNumber.includes(searchTerm);
            row.style.display = matches ? '' : 'none';
        });
    });
    if (map) {
        markers.forEach(marker => {
            const flight = marker.flight || {};
            const registration = flight.registration || '';
            const flightNumber = flight.flight_number || '';
            const matches = searchTerm === '' || registration.toUpperCase().includes(searchTerm) || flightNumber.toUpperCase().includes(searchTerm);
            if (matches) {
                if (!map.hasLayer(marker)) marker.addTo(map);
            } else {
                if (map.hasLayer(marker)) map.removeLayer(marker);
            }
        });
        map.invalidateSize();
    }
}

function toggleUpdates() {
    const updatesToggleBtn = document.getElementById('updates-toggle');
    if (!updatesToggleBtn) {
        console.error("Botón #updates-toggle no encontrado");
        return;
    }
    updatesEnabled = !updatesEnabled;
    updatesToggleBtn.classList.toggle('active', updatesEnabled);
    updatesToggleBtn.textContent = updatesEnabled ? 'Pausar Actualizaciones' : 'Reanudar Actualizaciones';
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'toggle_updates', enabled: updatesEnabled }));
    }
    console.log("Actualizaciones de vuelos:", updatesEnabled ? "activadas" : "pausadas");
}

function updateSwipeHint() {
    const swipeHint = document.getElementById('swipe-hint');
    if (!swipeHint) return;
    swipeHint.textContent = currentGroup 
        ? 'Desliza hacia la derecha para ver el grupo' 
        : 'Desliza hacia la izquierda para volver al grupo';
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

document.addEventListener('touchstart', (e) => {
    if (!currentGroup) return;
    isSwiping = true;
    startX = e.touches[0].clientX;
    currentX = startX;
});

document.addEventListener('touchmove', (e) => {
    if (!isSwiping || !currentGroup) return;
    currentX = e.touches[0].clientX;
    const diffX = startX - currentX;
    const main = document.getElementById('main');
    const groupScreen = document.getElementById('group-screen');
    if (diffX > 0 && main.style.display === 'block') {
        main.style.transform = `translateX(-${diffX}px)`;
    } else if (diffX < 0 && groupScreen.style.display === 'block') {
        groupScreen.style.transform = `translateX(${-diffX}px)`;
    }
});

document.addEventListener('touchend', () => {
    if (!isSwiping || !currentGroup) return;
    isSwiping = false;
    const diffX = startX - currentX;
    const threshold = window.innerWidth / 4;
    const main = document.getElementById('main');
    const groupScreen = document.getElementById('group-screen');
    if (diffX > threshold && main.style.display === 'block') {
        main.classList.add('slide-left');
        setTimeout(() => {
            main.style.display = 'none';
            main.style.transform = '';
            main.classList.remove('slide-left');
            groupScreen.style.display = 'block';
            groupScreen.style.transform = '';
            updateSwipeHint();
        }, 300);
    } else if (diffX < -threshold && groupScreen.style.display === 'block') {
        groupScreen.classList.add('slide-right');
        setTimeout(() => {
            groupScreen.style.display = 'none';
            groupScreen.style.transform = '';
            groupScreen.classList.remove('slide-right');
            main.style.display = 'block';
            main.style.transform = '';
            updateSwipeHint();
        }, 300);
    } else {
        main.style.transform = '';
        groupScreen.style.transform = '';
    }
});

function checkNotificationPermission() {
    if (!('Notification' in window)) {
        console.warn("Notificaciones no soportadas");
        return;
    }
    if (Notification.permission === 'default') {
        Notification.requestPermission().then(permission => {
            console.log("Permiso de notificaciones:", permission);
        });
    }
}

function showNotification(title, options) {
    if (!('Notification' in window)) {
        console.warn("Notificaciones no soportadas");
        return;
    }
    if (Notification.permission === 'granted') {
        new Notification(title, options);
    } else if (Notification.permission !== 'denied') {
        Notification.requestPermission().then(permission => {
            if (permission === 'granted') {
                new Notification(title, options);
            }
        });
    }
}

function registerServiceWorker() {
    if ('serviceWorker' in navigator) {
        navigator.serviceWorker.register('/sw.js').then(registration => {
            console.log('Service Worker registrado:', registration.scope);
        }).catch(error => {
            console.error('Error al registrar Service Worker:', error);
        });
    } else {
        console.warn("Service Worker no soportado");
    }
}

function logout() {
    if (ws && ws.readyState === WebSocket.OPEN) {
        ws.send(JSON.stringify({ type: 'logout', sessionToken: localStorage.getItem('sessionToken') }));
    } else {
        completeLogout();
    }
}

function completeLogout() {
    localStorage.removeItem('sessionToken');
    localStorage.removeItem('userName');
    localStorage.removeItem('userFunction');
    localStorage.removeItem('userLegajo');
    localStorage.removeItem('groupId');
    localStorage.removeItem('lastSearchQuery');
    userId = null;
    currentGroup = null;
    if (ws) {
        ws.close();
        ws = null;
    }
    stopPing();
    document.getElementById('main').style.display = 'none';
    document.getElementById('group-screen').style.display = 'none';
    document.getElementById('auth-section').style.display = 'block';
    displayUserProfile();
    updateSwipeHint();
    showError('Sesión cerrada exitosamente');
}

function base64ToBlob(base64, mime) {
    try {
        const byteString = atob(base64);
        const arrayBuffer = new ArrayBuffer(byteString.length);
        const uint8Array = new Uint8Array(arrayBuffer);
        for (let i = 0; i < byteString.length; i++) {
            uint8Array[i] = byteString.charCodeAt(i);
        }
        return new Blob([arrayBuffer], { type: mime });
    } catch (err) {
        console.error("Error al convertir base64 a Blob:", err);
        return null;
    }
}

document.addEventListener('DOMContentLoaded', () => {
    localStorage.removeItem('lastSearchQuery');
    filterFlights('');
    document.getElementById('register-form')?.addEventListener('submit', registerUser);
    document.getElementById('login-form')?.addEventListener('submit', loginUser);
    document.getElementById('show-login')?.addEventListener('click', () => {
        document.getElementById('register-form').style.display = 'none';
        document.getElementById('login-form').style.display = 'block';
    });
    document.getElementById('show-register')?.addEventListener('click', () => {
        document.getElementById('login-form').style.display = 'none';
        document.getElementById('register-form').style.display = 'block';
    });
    const logoutButton = document.getElementById('logout-button');
    if (logoutButton) logoutButton.addEventListener('click', logout);
    const returnToGroupBtn = document.getElementById('return-to-group-btn');
    if (returnToGroupBtn) returnToGroupBtn.addEventListener('click', returnToGroup);
    const talkButton = document.getElementById('talk');
    if (talkButton) talkButton.addEventListener('click', toggleTalk);
    const groupTalkButton = document.getElementById('group-talk');
    if (groupTalkButton) groupTalkButton.addEventListener('click', toggleGroupTalk);
    const muteButton = document.getElementById('mute');
    if (muteButton) muteButton.addEventListener('click', toggleMute);
    const groupMuteButton = document.getElementById('group-mute');
    if (groupMuteButton) groupMuteButton.addEventListener('click', toggleGroupMute);
    const muteNonGroupButton = document.getElementById('mute-non-group');
    if (muteNonGroupButton) muteNonGroupButton.addEventListener('click', toggleMuteNonGroup);
    const joinGroupBtn = document.getElementById('join-group-btn');
    if (joinGroupBtn) joinGroupBtn.addEventListener('click', joinGroup);
    const createGroupBtn = document.getElementById('create-group-btn');
    if (createGroupBtn) createGroupBtn.addEventListener('click', createGroup);
    const leaveGroupBtn = document.getElementById('leave-group-btn');
    if (leaveGroupBtn) leaveGroupBtn.addEventListener('click', leaveGroup);
    const radarBtn = document.getElementById('radar');
    if (radarBtn) radarBtn.addEventListener('click', showRadar);
    const groupRadarBtn = document.getElementById('group-radar');
    if (groupRadarBtn) groupRadarBtn.addEventListener('click', showGroupRadar);
    const historyBtn = document.getElementById('history');
    if (historyBtn) historyBtn.addEventListener('click', showHistory);
    const groupHistoryBtn = document.getElementById('group-history');
    if (groupHistoryBtn) groupHistoryBtn.addEventListener('click', showGroupHistory);
    const backToMainBtn = document.getElementById('back-to-main');
    if (backToMainBtn) backToMainBtn.addEventListener('click', backToMainFromGroup);
    const radarCloseBtn = document.querySelector('#radar-screen .close-btn');
    if (radarCloseBtn) radarCloseBtn.addEventListener('click', backToMainFromRadar);
    const updatesToggleBtn = document.getElementById('updates-toggle');
    if (updatesToggleBtn) updatesToggleBtn.addEventListener('click', toggleUpdates);
    const toggleAnnouncementsBtn = document.getElementById('toggle-announcements');
    if (toggleAnnouncementsBtn) {
        toggleAnnouncementsBtn.addEventListener('click', () => {
            announcementsEnabled = !announcementsEnabled;
            toggleAnnouncementsBtn.textContent = announcementsEnabled ? 'Desactivar anuncios de llegadas' : 'Activar anuncios de llegadas';
            console.log("Anuncios de llegadas:", announcementsEnabled ? "activados" : "desactivados");
        });
    }
    const toggleDepartureAnnouncementsBtn = document.getElementById('toggle-departure-announcements');
    if (toggleDepartureAnnouncementsBtn) {
        toggleDepartureAnnouncementsBtn.addEventListener('click', () => {
            departureAnnouncementsEnabled = !departureAnnouncementsEnabled;
            toggleDepartureAnnouncementsBtn.textContent = departureAnnouncementsEnabled ? 'Desactivar anuncios de despegues' : 'Activar anuncios de despegues';
            console.log("Anuncios de despegues:", departureAnnouncementsEnabled ? "activados" : "desactivados");
        });
    }
    const toggleTokenLimitBtn = document.getElementById('toggle-token-limit');
    if (toggleTokenLimitBtn) {
        toggleTokenLimitBtn.addEventListener('click', () => {
            restrictTokens = !restrictTokens;
            localStorage.setItem('restrictTokens', JSON.stringify(restrictTokens));
            toggleTokenLimitBtn.textContent = restrictTokens ? 'Desactivar límite de tokens' : 'Activar límite de tokens';
            console.log("Límite de tokens:", restrictTokens ? "activado" : "desactivado");
        });
    }
    const searchButton = document.getElementById('search-button');
    if (searchButton) {
        searchButton.addEventListener('click', () => {
            const searchTerm = document.getElementById('search-input')?.value || '';
            localStorage.setItem('lastSearchQuery', searchTerm);
            filterFlights(searchTerm);
        });
    }
    checkNotificationPermission();
    registerServiceWorker();
    initMap();
});

const style = document.createElement('style');
style.textContent = `
    .slide-left {
        transition: transform 0.3s ease-out;
        transform: translateX(-100%);
    }
    .slide-right {
        transition: transform 0.3s ease-out;
        transform: translateX(100%);
    }
    .recording {
        background-color: red;
        color: white;
    }
    .muted {
        background-color: #ccc;
    }
    .unmuted {
        background-color: #4CAF50;
    }
    .user-item {
        display: flex;
        align-items: center;
        margin: 5px 0;
    }
    .mute-button {
        margin-right: 10px;
    }
    .chat-message {
        cursor: pointer;
        margin: 5px 0;
    }
    .play-icon {
        margin-right: 5px;
    }
    .in-group {
        font-weight: bold;
    }
    .tams-row {
        cursor: pointer;
    }
    .tams-details-btn {
        padding: 5px 10px;
        background-color: #007bff;
        color: white;
        border: none;
        border-radius: 3px;
        cursor: pointer;
    }
    .tams-details-btn:hover {
        background-color: #0056b3;
    }
    .toggle-btn {
        padding: 10px;
        background-color: #007bff;
        color: white;
        border: none;
        border-radius: 5px;
        cursor: pointer;
    }
    .toggle-btn.active {
        background-color: #28a745;
    }
`;
document.head.appendChild(style);
