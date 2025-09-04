import os
import sys
import time
import threading

from PyQt6.QtWidgets import QApplication, QMainWindow
from PyQt6.QtWebEngineWidgets import QWebEngineView
from PyQt6.QtWebEngineCore import QWebEngineSettings
from PyQt6.QtCore import QUrl, QObject, pyqtSlot, Qt, QPropertyAnimation, QEasingCurve, QTimer
from PyQt6.QtWebChannel import QWebChannel
from PyQt6.QtGui import QIcon
from PyQt6.QtWebEngineCore import QWebEngineProfile
from PyQt6.QtWebEngineCore import QWebEngineProfile, QWebEnginePage

from pypresence import Presence
import subprocess

def is_connected():
    try:
        output = subprocess.run(
            ["ping", "-n" if os.name == "nt" else "-c", "1", "google.com"],
            stdout=subprocess.DEVNULL,
            stderr=subprocess.DEVNULL
        )
        return output.returncode == 0
    except Exception:
        return False

os.environ['QTWEBENGINE_CHROMIUM_FLAGS'] = (
    '--disable-software-rasterizer '
    '--disable-accelerated-2d-canvas '
    '--disable-background-timer-throttling '
    '--disable-renderer-backgrounding'
)

def rpc():
    try:
        client_id = '1395388116105429195'
        RPC = Presence(client_id)
        RPC.connect()

        RPC.update(
            details="Слушает STEENY",
            start=time.time(),
            large_image="prew",
            large_text="STEENY",
            small_image="logo",
            small_text="STEENY Networks",
            buttons=[
                {"label": "GitHub", "url": "https://github.com/Ivan0n"}
            ]
        )
        print("Rich Presence установлен.")
    except Exception as e:
        print(f"Ошибка RPC: {e}")

class Bridge(QObject):
    def __init__(self, window):
        super().__init__()
        self.window = window

    @pyqtSlot()
    def close_app(self):
        self.window.fade_and_close() 

    @pyqtSlot()
    def minimize_app(self):
        self.window.fade_and_minimize()  
    @pyqtSlot(int, int)
    def move_window(self, x, y):
        self.window.move(x, y)

class Browser(QMainWindow):
    def __init__(self, url):
        super().__init__()
        self.setWindowTitle("STEENY - лучший стриминговый сервис")
        self.setGeometry(100, 100, 1024, 768)
        self.setWindowFlag(Qt.WindowType.FramelessWindowHint)
        self.setWindowIcon(QIcon("icon.ico"))

        self.browser = QWebEngineView()
        self.setCentralWidget(self.browser)


        profile_path = os.path.join(os.getcwd(), "profile")
        self.profile = QWebEngineProfile("SSTEENYProfile", self)
        self.profile.setPersistentCookiesPolicy(QWebEngineProfile.PersistentCookiesPolicy.ForcePersistentCookies)
        self.profile.setCachePath(os.path.join(profile_path, "cache"))
        self.profile.setPersistentStoragePath(os.path.join(profile_path, "storage"))

        self.page = QWebEnginePage(self.profile, self.browser)
        self.browser.setPage(self.page)

        self.browser.settings().setAttribute(QWebEngineSettings.WebAttribute.FullScreenSupportEnabled, True)
        self.browser.settings().setAttribute(QWebEngineSettings.WebAttribute.PlaybackRequiresUserGesture, False)
        self.browser.settings().setAttribute(QWebEngineSettings.WebAttribute.PluginsEnabled, False)
        self.browser.settings().setAttribute(QWebEngineSettings.WebAttribute.JavascriptCanOpenWindows, True)  
        self.browser.settings().setAttribute(QWebEngineSettings.WebAttribute.LocalStorageEnabled, True)      
        self.browser.settings().setAttribute(QWebEngineSettings.WebAttribute.XSSAuditingEnabled, True)

        self.channel = QWebChannel()
        self.bridge = Bridge(self)
        self.channel.registerObject("bridge", self.bridge)
        self.browser.page().setWebChannel(self.channel)

        self.browser.page().profile().setHttpUserAgent(
            "Mozilla/5.0 (Windows NT 10.0; Win64; x64) "
            "AppleWebKit/537.36 (KHTML, like Gecko) "
            "Chrome/120.0.0.0 Safari/537.36"
        )

        self.browser.load(QUrl(url))


    def fade_and_close(self):
        self.animation = QPropertyAnimation(self, b"windowOpacity")
        self.animation.setDuration(300)
        self.animation.setStartValue(1.0)
        self.animation.setEndValue(0.0)
        self.animation.setEasingCurve(QEasingCurve.Type.InOutQuad)
        self.animation.finished.connect(self.close)
        self.animation.start()


    def fade_and_minimize(self):
        self.animation = QPropertyAnimation(self, b"windowOpacity")
        self.animation.setDuration(300)
        self.animation.setStartValue(1.0)
        self.animation.setEndValue(0.0)
        self.animation.setEasingCurve(QEasingCurve.Type.InOutQuad)

        def minimize_and_restore_opacity():
            self.showMinimized()
            self.setWindowOpacity(1.0)

        self.animation.finished.connect(minimize_and_restore_opacity)
        self.animation.start()

if __name__ == "__main__":
    app = QApplication(sys.argv)
    app.setApplicationDisplayName("STEENY")
    app.setOrganizationName("Ivan0n co.")
    app.setWindowIcon(QIcon("icon.ico"))

    if is_connected():
        url = "http://127.0.0.1:2020/home"
    else:
        local_file = os.path.abspath("ofline.html")
        url = QUrl.fromLocalFile(local_file).toString()

    window = Browser(url)

    window.show()

    threading.Thread(target=rpc, daemon=True).start()

    sys.exit(app.exec())