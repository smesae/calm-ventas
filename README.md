# CALM Ventas B2B — PWA

App de gestión de cuentas B2B para Rest Company SpA (marca CALM).

**En vivo:** https://smesae.github.io/calm-ventas/

## Cómo actualizar la app

Esta carpeta (`app/pwa/`) ES el repositorio desplegado. Para publicar cambios:

```bash
cd /Users/smesa/CALM/CALM-Finanzas/BI/B2B/app/pwa
git add .
git commit -m "descripción del cambio"
git push
```

GitHub Pages reconstruye solo en ~1 minuto. No hay que reinstalar nada en los teléfonos.

> Al cambiar `app.js` o `config.js`, subir el número de versión `?v=N` en `index.html`
> (líneas de `<script src=...>`) para que los navegadores tomen la versión nueva.

## Archivos
- `index.html` — estructura + estilos (CSS inline)
- `app.js` — toda la lógica (conecta a Supabase)
- `config.js` — URL + anon key de Supabase (pública por diseño; RLS protege los datos)
- `manifest.json` + `sw.js` + iconos — para instalar como app en el celular

## Backend
Supabase proyecto `calm-b2b` (ypsjydadpejmoyqkeaos). Acceso restringido por RLS a
correos autorizados. Fuente de ventas: buzón de intercambio con el agente Bsale.
