let bridge;
let isDragging = false;
let offsetX = 0;
let offsetY = 0;

window.onload = () => {
    new QWebChannel(qt.webChannelTransport, function(channel) {
        bridge = channel.objects.bridge;

        document.querySelector(".close").onclick = () => {
            bridge.close_app();
        };

        document.querySelector(".minimize").onclick = () => {
            bridge.minimize_app();
        };

        const windowBar = document.querySelector(".window-bar");

        windowBar.addEventListener("mousedown", (e) => {
            if (e.button !== 0) return;

            isDragging = true;
                    // Запоминаем смещение курсора относительно окна
            offsetX = e.screenX - window.screenX;
            offsetY = e.screenY - window.screenY;
        });

        window.addEventListener("mousemove", (e) => {
            if (isDragging) {
                    const newX = e.screenX - offsetX;
                    const newY = e.screenY - offsetY;
                    bridge.move_window(newX, newY);
                }
            });

            window.addEventListener("mouseup", () => {
                isDragging = false;
            });
    });
};