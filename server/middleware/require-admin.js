/**
 * Modul: requireAdmin-Middleware
 * Zweck: Admin-Gate für Routen, die Konfiguration schreiben.
 *
 * Steht bewusst hier und nicht in server/auth.js: dieses Modul ist frei von
 * Seiteneffekten. auth.js prüft beim Laden SESSION_SECRET und wirft ohne, sodass
 * jeder Router, der von dort nur das Admin-Gate zieht, in Tests eine vollständige
 * Umgebung erzwingen würde, obwohl er nichts davon braucht. auth.js exportiert
 * diese Funktion unverändert weiter - Bestandsimporte bleiben gültig.
 */

/** Lässt nur Admins durch; alle anderen erhalten 403. */
export function requireAdmin(req, res, next) {
  if (req.authRole === 'admin') {
    return next();
  }
  res.status(403).json({ error: 'Permission denied.', code: 403 });
}
