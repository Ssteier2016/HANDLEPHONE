let ws;
let userId;
let mediaRecorder;
let audioChunks = [];

function register() {
    const legajo = document.getElementById("legajo").value;
    const name = document.getElementById("name").value;
    userId = `${legajo}_${name}`;
    ws = new WebSocket(`wss://${window.location.host}/ws/${userId}`);
    
    ws.onopen = function() {
        ws.send(JSON.stringify({ type: "register", legajo: legajo, name: name }));
        document.getElementById("register").style.display = "none";
        document.getElementById("main").style.display = "block";
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
}

function toggleTalk() {
    const talkButton = document.getElementById("talk");
    if (talkButton.style.backgroundColor === "green") {
        mediaRecorder.stop();
        talkButton.style.backgroundColor = "red";
    } else {
        navigator.mediaDevices.getUserMedia({ audio: true })
            .then(stream => {
                // Especificar formato WAV si es posible (depende del navegador)
                mediaRecorder = new MediaRecorder(stream, { mimeType: 'audio/webm;codecs=pcm' }); // Intentamos PCM
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
                talkButton.style.backgroundColor = "green";
            })
            .catch(err => console.error("Error al acceder al micrófono:", err));
    }
}

function toggleMute() {
    const muteButton = document.getElementById("mute");
    if (muteButton.style.backgroundColor === "red") {
        ws.send(JSON.stringify({ type: "unmute" }));
        muteButton.style.backgroundColor = "green";
    } else {
        ws.send(JSON.stringify({ type: "mute" }));
        muteButton.style.backgroundColor = "red";
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
        });
}

function backToMain() {
    document.getElementById("history-screen").style.display = "none";
    document.getElementById("main").style.display = "block";
}
