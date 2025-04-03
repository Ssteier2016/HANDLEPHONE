let ws;
let recording = false;
let mediaRecorder;
let userId;

function register() {
    const legajo = document.getElementById("legajo").value;
    const name = document.getElementById("name").value;
    if (legajo && name) {
        userId = `${legajo}_${name}`;
        ws = new WebSocket(`wss://${window.location.host}/ws/${userId}`);
        ws.onopen = () => {
            ws.send(JSON.stringify({ type: "register", name }));
            document.getElementById("register").style.display = "none";
            document.getElementById("main").style.display = "block";
        };
        ws.onmessage = handleMessage;
    }
}

function toggleTalk() {
    const talkBtn = document.getElementById("talk");
    if (!recording) {
        talkBtn.textContent = "Grabando...";
        talkBtn.classList.add("recording");
        startRecording();
    } else {
        talkBtn.textContent = "Hablar";
        talkBtn.classList.remove("recording");
        stopRecording();
    }
    recording = !recording;
}

function startRecording() {
    navigator.mediaDevices.getUserMedia({ audio: true }).then(stream => {
        mediaRecorder = new MediaRecorder(stream);
        mediaRecorder.ondataavailable = e => {
            e.data.arrayBuffer().then(buffer => {
                const reader = new FileReader();
                reader.readAsDataURL(e.data);
                reader.onloadend = () => {
                    const base64data = reader.result.split(',')[1];
                    ws.send(JSON.stringify({ type: "audio", data: base64data }));
                };
            });
        };
        mediaRecorder.start(100); // Enviar datos cada 100ms para tiempo real
    });
}

function stopRecording() {
    mediaRecorder.stop();
    mediaRecorder.stream.getTracks().forEach(track => track.stop());
}

function toggleMute() {
    const muteBtn = document.getElementById("mute");
    if (muteBtn.textContent === "Mutear") {
        muteBtn.textContent = "Desmutear";
        muteBtn.classList.add("muted");
        ws.send(JSON.stringify({ type: "mute" }));
    } else {
        muteBtn.textContent = "Mutear";
        muteBtn.classList.remove("muted");
        ws.send(JSON.stringify({ type: "unmute" }));
    }
}

function showHistory() {
    document.getElementById("main").style.display = "none";
    document.getElementById("history-screen").style.display = "block";
    fetch("/history").then(res => res.json()).then(data => {
        const historyList = document.getElementById("history-list");
        historyList.innerHTML = "";
        data.forEach(msg => {
            historyList.innerHTML += `
                <p>${msg.date} ${msg.timestamp} - ${msg.user_id.split("_")[1]}: ${msg.text}
                <button onclick="playAudio('${msg.audio}')">Reproducir</button></p>`;
        });
    });
}

function backToMain() {
    document.getElementById("main").style.display = "block";
    document.getElementById("history-screen").style.display = "none";
}

function handleMessage(event) {
    const data = JSON.parse(event.data);
    if (data.type === "audio") {
        const audio = new Audio(`data:audio/wav;base64,${data.data}`);
        audio.play();
        const messageList = document.getElementById("message-list");
        messageList.innerHTML += `<p>${data.timestamp} - ${data.sender}: ${data.text}</p>`;
    } else if (data.type === "users") {
        document.getElementById("users").textContent = `Usuarios conectados: ${data.count} (${data.list.join(", ")})`;
    }
}

function playAudio(base64data) {
    const audio = new Audio(`data:audio/wav;base64,${base64data}`);
    audio.play();
}
