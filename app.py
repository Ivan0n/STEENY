import os
import sys
import time
import threading

from PyQt6.QtWidgets import (QApplication, QMainWindow, QWidget, QHBoxLayout, 
                             QPushButton, QSpacerItem, QSizePolicy, QVBoxLayout)
from PyQt6.QtWebEngineWidgets import QWebEngineView
from PyQt6.QtWebEngineCore import QWebEngineSettings
from PyQt6.QtCore import QUrl, QObject, pyqtSlot, Qt, QPropertyAnimation, QEasingCurve, QTimer
from PyQt6.QtWebChannel import QWebChannel
from PyQt6.QtGui import QIcon, QPainter, QColor
from PyQt6.QtWebEngineCore import QWebEngineProfile, QWebEnginePage
from PyQt6.QtCore import QEvent
from PyQt6.QtGui import QWheelEvent

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
    '--autoplay-policy=no-user-gesture-required '
    '--ignore-gpu-blocklist '
    '--enable-features=AudioServiceOutOfProcess '
    '--enable-features=AudioServiceAudioStreams '
    '--disable-geolocation '
    '--disable-translate '
    '--disable-sync '
    '--disable-print-preview '
    '--disable-extensions '
    '--disable-component-update '
    '--disable-web-security '  
    '--allow-running-insecure-content '
    '--ignore-certificate-errors'
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
        )
        print("Rich Presence установлен.")
    except Exception as e:
        print(f"Ошибка RPC: {e}")
class Bridge(QObject):
    def __init__(self, window):
        super().__init__()
        self.window = window
        self.rpc_enabled = True
        self.rpc_thread = None

    @pyqtSlot(bool)  
    def toggle_rpc(self, state: bool):
        self.rpc_enabled = state
        if state:
            if not self.rpc_thread or not self.rpc_thread.is_alive():
                self.rpc_thread = threading.Thread(target=rpc, daemon=True)
                self.rpc_thread.start()
                print("RPC включён")
        else:
            print("RPC выключен (перезапусти Discord, чтобы очистить статус)")

class TitleBar(QWidget):
    def __init__(self, parent):
        super().__init__(parent)
        self.parent = parent
        self.setFixedHeight(30)
        self.setStyleSheet("background-color: black;")
        
        layout = QHBoxLayout(self)
        layout.setContentsMargins(5, 0, 5, 0)
        layout.setSpacing(5)

        spacer = QSpacerItem(20, 20, QSizePolicy.Policy.Expanding, QSizePolicy.Policy.Minimum)
        

        self.minimize_btn = QPushButton("—")
        self.minimize_btn.setFixedSize(20, 20)
        self.minimize_btn.setStyleSheet("""
            QPushButton {
                background-color: #333333;
                color: white;
                border: none;
                border-radius: 3px;
                font-weight: bold;
            }
            QPushButton:hover {
                background-color: #555555;
            }
        """)
        self.minimize_btn.clicked.connect(self.parent.showMinimized)
        

        self.maximize_btn = QPushButton("□")
        self.maximize_btn.setFixedSize(20, 20)
        self.maximize_btn.setStyleSheet("""
            QPushButton {
                background-color: #333333;
                color: white;
                border: none;
                border-radius: 3px;
                font-weight: bold;
            }
            QPushButton:hover {
                background-color: #555555;
            }
        """)
        self.maximize_btn.clicked.connect(self.toggle_maximize)
        

        self.close_btn = QPushButton("×")
        self.close_btn.setFixedSize(20, 20)
        self.close_btn.setStyleSheet("""
            QPushButton {
                background-color: #333333;
                color: white;
                border: none;
                border-radius: 3px;
                font-weight: bold;
            }
            QPushButton:hover {
                background-color: #FF5555;
            }
        """)
        self.close_btn.clicked.connect(self.parent.close)
        
        layout.addItem(spacer)
        layout.addWidget(self.minimize_btn)
        layout.addWidget(self.maximize_btn)
        layout.addWidget(self.close_btn)
    
    def toggle_maximize(self):
        if self.parent.isMaximized():
            self.parent.showNormal()
        else:
            self.parent.showMaximized()

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
        QWebEngineProfile.defaultProfile().clearHttpCache()
        QWebEngineProfile.defaultProfile().clearAllVisitedLinks()

    @pyqtSlot(int, int)
    def move_window(self, x, y):
        self.window.move(x, y)

class Browser(QMainWindow):
    def __init__(self, url):
        super().__init__()
        
        self.setWindowTitle("STEENY - лучший стриминговый сервис")
        self.setGeometry(100, 100, 1354, 868)
        self.setWindowIcon(QIcon("icon.ico"))
        

        

        central_widget = QWidget()
        self.setCentralWidget(central_widget)
        
        main_layout = QVBoxLayout(central_widget)
        main_layout.setContentsMargins(0, 0, 0, 0)
        main_layout.setSpacing(0)
        

        self.title_bar = TitleBar(self)
        main_layout.addWidget(self.title_bar)
        

        self.browser = QWebEngineView()
        main_layout.addWidget(self.browser)

        profile_path = os.path.join(os.getcwd(), "profile")
        self.profile = QWebEngineProfile("STEENYProfile", self)
        self.profile.setPersistentCookiesPolicy(QWebEngineProfile.PersistentCookiesPolicy.ForcePersistentCookies)
        self.profile.setCachePath(os.path.join(profile_path, "cache"))
        self.profile.setPersistentStoragePath(os.path.join(profile_path, "storage"))

        self.page = QWebEnginePage(self.profile, self.browser)
        self.browser.setPage(self.page)
        
        self.setWindowFlags(
            Qt.WindowType.FramelessWindowHint |
            Qt.WindowType.Window |
            Qt.WindowType.CustomizeWindowHint 

        )


        self.browser.settings().setAttribute(QWebEngineSettings.WebAttribute.FullScreenSupportEnabled, True)
        self.browser.settings().setAttribute(QWebEngineSettings.WebAttribute.PlaybackRequiresUserGesture, True)

        self.browser.settings().setAttribute(QWebEngineSettings.WebAttribute.PluginsEnabled, False)
        self.browser.settings().setAttribute(QWebEngineSettings.WebAttribute.JavascriptCanOpenWindows, True)  
        self.browser.settings().setAttribute(QWebEngineSettings.WebAttribute.LocalStorageEnabled, True)      
        self.browser.settings().setAttribute(QWebEngineSettings.WebAttribute.XSSAuditingEnabled, True)
        self.browser.settings().setAttribute(QWebEngineSettings.WebAttribute.PluginsEnabled, False)
        self.browser.settings().setAttribute(QWebEngineSettings.WebAttribute.JavascriptCanOpenWindows, False)
        self.browser.settings().setAttribute(QWebEngineSettings.WebAttribute.LocalStorageEnabled, True)  
        self.browser.settings().setAttribute(QWebEngineSettings.WebAttribute.XSSAuditingEnabled, False) 
        self.browser.settings().setAttribute(QWebEngineSettings.WebAttribute.ErrorPageEnabled, False)

        self.channel = QWebChannel()
        self.bridge = Bridge(self)
        self.channel.registerObject("bridge", self.bridge)
        self.browser.page().setWebChannel(self.channel)


        self.browser.loadFinished.connect(self.disable_zoom)

        self.browser.load(QUrl(url))
        

        self.old_pos = None
    
    def mousePressEvent(self, event):
        if event.button() == Qt.MouseButton.LeftButton:
            self.old_pos = event.globalPosition().toPoint() - self.frameGeometry().topLeft()
            event.accept()
    def wheelEvent(self, event):

        if event.modifiers() == Qt.KeyboardModifier.ControlModifier:

            event.ignore()
        else:

            super().wheelEvent(event)
    def mouseMoveEvent(self, event):
        if self.old_pos is not None and event.buttons() == Qt.MouseButton.LeftButton:
            self.move(event.globalPosition().toPoint() - self.old_pos)
            event.accept()
    
    def mouseReleaseEvent(self, event):
        self.old_pos = None
        event.accept()

    def changeEvent(self, event):
        if event.type() == QEvent.Type.WindowStateChange:
            if self.isMinimized():
                print("closed")
                
                self.browser.hide()
            else:
                print("opened")
                self.browser.show()
        super().changeEvent(event)
    def disable_zoom(self):
        zoom_block_script = """
        document.addEventListener('wheel', function(e) {
            if (e.ctrlKey) {
                e.preventDefault();
                return false;
            }
        }, { passive: false });
        
        document.addEventListener('keydown', function(e) {
            if (e.ctrlKey && (e.key === '+' || e.key === '-' || e.key === '0' || 
                              e.keyCode === 107 || e.keyCode === 109 || e.keyCode === 48)) {
                e.preventDefault();
                return false;
            }
        });
        """
        self.browser.page().runJavaScript(zoom_block_script)
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
        url = "https://music.steeny.fun/home"
    else:
        local_file = os.path.abspath("ofline.html")
        url = QUrl.fromLocalFile(local_file).toString()

    window = Browser(url)
    window.show()

    threading.Thread(target=rpc, daemon=True).start()

    sys.exit(app.exec())