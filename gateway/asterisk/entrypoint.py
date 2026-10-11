"""Render private Asterisk connection settings; never print credentials."""
import os
import re
import shutil
from pathlib import Path
from media_config import media_configuration


def setting(name, default=None):
    value = os.environ.get(name, default)
    # Asterisk's configuration parser treats semicolons/newlines specially.
    # Generated service secrets should use base64 or base64url.
    if not value or not re.fullmatch(r"[A-Za-z0-9_.:/@+%=,\[\]-]+", value):
        raise SystemExit(f"Missing or unsafe configuration: {name}")
    if name.startswith('SIPPER_DB_') and len(value) > 63:
        raise SystemExit(f"Asterisk's database driver requires at most 63 characters: {name}")
    return value


def write(name, text):
    path = Path('/etc/asterisk') / name
    path.write_text(text)
    path.chmod(0o600)


os.umask(0o077)
# A private tmpfs can replace /etc/asterisk on a read-only deployment. Preserve
# explicitly mounted fixture/operator files and initialise only missing defaults.
for source in Path('/usr/share/sipper-asterisk/config').glob('*.conf'):
    destination = Path('/etc/asterisk') / source.name
    if not destination.exists():
        shutil.copyfile(source, destination)
write('res_pgsql.conf', f"""[general]
hostname = {setting('SIPPER_DB_HOST')}
port = {setting('SIPPER_DB_PORT', '5432')}
dbname = {setting('SIPPER_DB_NAME')}
user = {setting('SIPPER_DB_USER')}
password = {setting('SIPPER_DB_PASSWORD')}
appname = sipper-gateway
requirements = warn
""")
# libpq verifies the database peer in production. The isolated compose test
# explicitly selects disable for its container-only, non-TLS Postgres fixture.
os.environ.setdefault('PGSSLMODE', 'verify-full')
for path in ['/run/tls/server.crt', '/run/tls/server.key']:
    if not os.access(path, os.R_OK):
        raise SystemExit(f"Missing readable TLS file: {path}")
upstream_ca = setting('SIPPER_UPSTREAM_CA_FILE', '/etc/ssl/certs/ca-certificates.crt')
if not os.access(upstream_ca, os.R_OK):
    raise SystemExit('Missing readable upstream CA file')
rtp_config, media_transport = media_configuration(os.environ)
write('rtp.conf', rtp_config)
write('pjsip.conf', f"""[global]
type = global
endpoint_identifier_order = auth_username,username
disable_multi_domain = yes
user_agent = Sipper Gateway
default_auth_algorithms_uac = sha-256
default_auth_algorithms_uas = sha-256
[sipper-tls]
type = transport
protocol = tls
bind = 0.0.0.0:5061
method = tlsv1_2
cert_file = /run/tls/server.crt
priv_key_file = /run/tls/server.key
verify_server = yes
ca_list_file = {upstream_ca}
{media_transport}
""")
if os.environ.get('SIPPER_ARI_PASSWORD'):
    password = setting('SIPPER_ARI_PASSWORD')
    if len(password) < 32:
        raise SystemExit('SIPPER_ARI_PASSWORD must have at least 32 characters')
    write('ari.conf', f"""[general]
enabled = yes
pretty = no
[sipper-controller]
type = user
read_only = no
password = {password}
""")
    write('http.conf', f"""[general]
enabled = yes
bindaddr = {setting('SIPPER_ARI_BIND', '127.0.0.1')}
bindport = 8088
""")
if os.environ.get('SIPPER_AMI_PASSWORD'):
    password = setting('SIPPER_AMI_PASSWORD')
    if len(password) < 32:
        raise SystemExit('SIPPER_AMI_PASSWORD must have at least 32 characters')
    write('manager.conf', f"""[general]
enabled = yes
webenabled = no
bindaddr = {setting('SIPPER_AMI_BIND', '127.0.0.1')}
port = 5038
displayconnects = no
[sipper-observer]
secret = {password}
read = none
write = reporting
""")
else:
    write('manager.conf', '[general]\nenabled = no\nwebenabled = no\n')
os.execvp('asterisk', ['asterisk', '-f'])
