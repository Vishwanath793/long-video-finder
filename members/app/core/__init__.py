from .updater import activate_user_lib

# Must run before any module imports yt_dlp (lets the packaged exe use an updated copy).
activate_user_lib()
