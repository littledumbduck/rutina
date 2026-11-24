"""Firma de Tuya calculada como lo hace tinytuya (Cloud._tuyaplatform), para comparar con Codigo.gs.

Uso: python3 firma_referencia.py ACCESS_ID SECRET TOKEN T METODO RUTA_CON_QUERY CUERPO
"""
import hashlib
import hmac
import sys

access_id, secret, token, t, metodo, ruta, cuerpo = sys.argv[1:8]
payload = access_id + token + t
payload += (
    "%s\n" % metodo
    + hashlib.sha256(cuerpo.encode("utf-8")).hexdigest() + "\n"
    + "" + "\n"
    + ruta
)
print(hmac.new(secret.encode("utf-8"), msg=payload.encode("utf-8"), digestmod=hashlib.sha256).hexdigest().upper())
