// CALM B2B — Configuración de conexión a Supabase
// La anon key es pública por diseño (RLS protege los datos).
window.CALM_CONFIG = {
  SUPABASE_URL: 'https://ypsjydadpejmoyqkeaos.supabase.co',
  SUPABASE_ANON_KEY: 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Inlwc2p5ZGFkcGVqbW95cWtlYW9zIiwicm9sZSI6ImFub24iLCJpYXQiOjE3ODM2NzI0OTgsImV4cCI6MjA5OTI0ODQ5OH0.J5NR5S2_5j-toJMCwL5P7ZaL2UMQHGGT_0vr1CyWRkw',
  // Corte de referencia: último mes con datos de venta (mientras no haya Bsale en vivo)
  FECHA_CORTE: '2026-03-01',
};
