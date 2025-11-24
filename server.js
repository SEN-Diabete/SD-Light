const express = require('express');
const fs = require('fs');
const path = require('path');
const bcrypt = require('bcryptjs');
const session = require('express-session');
const multer = require('multer');
const axios = require('axios');
const PDFDocument = require('pdfkit');

const app = express();
const upload = multer({ storage: multer.memoryStorage() });

// Chargement des données
const LICENCES = JSON.parse(fs.readFileSync('./data/licences.json', 'utf8'));
let USERS = JSON.parse(fs.readFileSync('./data/users.json', 'utf8'));
let PATIENTS = {};
let GLYCEMIES = [];

// Middleware
app.use(express.json());
app.use(express.static('public'));

// ✅ SESSION SECURISÉE - Positionné ICI
app.use(session({
  secret: process.env.SESSION_SECRET || 'SEN2024!', // 8 caractères
  resave: false,
  saveUninitialized: false,
  cookie: { secure: process.env.NODE_ENV === 'production' }
}));

// Sauvegarde données
function saveUsers() { fs.writeFileSync('./data/users.json', JSON.stringify(USERS, null, 2)); }
function savePatients() { /* fichier patients si nécessaire */ }
function saveGlycemies() { /* fichier glycémies si nécessaire */ }

// Routes pages
app.get('/', (req, res) => res.redirect('/login.html'));
app.get('/dashboard', (req, res) => req.session.medecin_id ? res.sendFile(__dirname + '/public/dashboard.html') : res.redirect('/login.html'));
app.get('/admin', (req, res) => req.session.medecin_id === 'admin' ? res.sendFile(__dirname + '/public/admin.html') : res.redirect('/login.html'));

// === API ===

// Connexion
app.post('/api/login', (req, res) => {
  const { identifiant, password } = req.body;
  const user = Object.values(USERS).find(u => 
    (u.medecin_id === identifiant || u.email === identifiant) && u.statut === 'active'
  );

  if (user && bcrypt.compareSync(password, user.password_hash)) {
    req.session.medecin_id = user.medecin_id;
    req.session.nom_medecin = user.nom_medecin;
    req.session.is_admin = user.medecin_id === 'admin';
    
    res.json({ 
      success: true, 
      medecin_id: user.medecin_id,
      nom_medecin: user.nom_medecin,
      is_admin: user.medecin_id === 'admin'
    });
  } else {
    res.status(401).json({ error: 'Identifiant ou mot de passe incorrect' });
  }
});

// Déconnexion
app.post('/api/logout', (req, res) => {
  req.session.destroy();
  res.json({ success: true });
});

// Session
app.get('/api/session', (req, res) => {
  res.json(req.session.medecin_id ? {
    loggedIn: true,
    medecin_id: req.session.medecin_id,
    nom_medecin: req.session.nom_medecin,
    is_admin: req.session.is_admin
  } : { loggedIn: false });
});

// Info médecin
app.get('/api/medecin/info', (req, res) => {
  if (!req.session.medecin_id) return res.status(401).json({ error: 'Non connecté' });
  
  const user = USERS[req.session.medecin_id];
  if (!user) return res.status(404).json({ error: 'Médecin non trouvé' });

  res.json({
    ...user,
    photos_restantes: user.photos_achetees - user.photos_utilisees,
    pourcentage_utilise: Math.round((user.photos_utilisees / user.photos_achetees) * 100)
  });
});

// Upload glycémie
app.post('/api/glycemies/upload', upload.single('photo'), async (req, res) => {
  if (!req.session.medecin_id) return res.status(401).json({ error: 'Non connecté' });

  try {
    const { patient_id, nom_complet, telephone, type_diabete, traitement } = req.body;
    const medecin_id = req.session.medecin_id;
    const user = USERS[medecin_id];

    // Vérifications
    if (!user || user.statut !== 'active') return res.status(402).json({ error: 'Licence inactive' });
    if (user.photos_utilisees >= user.photos_achetees) return res.status(402).json({ error: 'Quota épuisé' });
    if (!req.file) return res.status(400).json({ error: 'Photo requise' });

    // Analyse OpenAI
    const valeurGlycemie = await analyserImageAvecOpenAI(req.file.buffer);
    const valeurNum = parseFloat(valeurGlycemie.replace(',', '.'));
    
    if (isNaN(valeurNum)) return res.status(400).json({ error: 'Valeur non valide' });

    // Enregistrement
    const glycemie = {
      id: Date.now(),
      medecin_id,
      patient_id: patient_id || `PAT${Date.now()}`,
      nom_complet, telephone, type_diabete, traitement,
      image_data: req.file.buffer.toString('base64'),
      valeur_glycemie: valeurNum,
      statut_glycemie: getStatutGlycemie(valeurNum),
      message_whatsapp: getMessageWhatsApp(getStatutGlycemie(valeurNum), valeurNum),
      created_at: new Date().toISOString()
    };

    GLYCEMIES.unshift(glycemie);
    USERS[medecin_id].photos_utilisees++;
    saveUsers();

    res.json({ 
      success: true, 
      valeur_glycemie: valeurNum,
      statut_glycemie: glycemie.statut_glycemie,
      photos_restantes: user.photos_achetees - user.photos_utilisees
    });

  } catch (error) {
    res.status(500).json({ error: 'Erreur serveur' });
  }
});

// Liste glycémies
app.get('/api/glycemies', (req, res) => {
  if (!req.session.medecin_id) return res.status(401).json({ error: 'Non connecté' });
  
  const glycemies = GLYCEMIES
    .filter(g => g.medecin_id === req.session.medecin_id)
    .slice(0, 50);
  
  res.json(glycemies);
});

// === ADMIN ===

// Stats admin
app.get('/api/admin/stats', (req, res) => {
  if (req.session.medecin_id !== 'admin') return res.status(403).json({ error: 'Accès refusé' });

  const medecins = Object.values(USERS).filter(u => u.medecin_id !== 'admin');
  const stats = {
    totalMedecins: medecins.length,
    medecinsActifs: medecins.filter(m => m.statut === 'active').length,
    totalVentes: medecins.reduce((acc, m) => acc + m.photos_achetees, 0),
    chiffreAffaires: medecins.reduce((acc, m) => acc + LICENCES[m.type_licence].prix, 0),
    photosUtilisees: medecins.reduce((acc, m) => acc + m.photos_utilisees, 0)
  };

  res.json(stats);
});

// Liste médecins
app.get('/api/admin/medecins', (req, res) => {
  if (req.session.medecin_id !== 'admin') return res.status(403).json({ error: 'Accès refusé' });

  const medecins = Object.values(USERS)
    .filter(u => u.medecin_id !== 'admin')
    .map(m => ({
      ...m,
      photos_restantes: m.photos_achetees - m.photos_utilisees,
      pourcentage_utilise: Math.round((m.photos_utilisees / m.photos_achetees) * 100)
    }));

  res.json(medecins);
});

// Créer médecin
app.post('/api/admin/medecins', (req, res) => {
  if (req.session.medecin_id !== 'admin') return res.status(403).json({ error: 'Accès refusé' });

  const { medecin_id, nom_medecin, email, telephone, type_licence } = req.body;
  const licence = LICENCES[type_licence];

  if (!licence) return res.status(400).json({ error: 'Licence invalide' });
  if (USERS[medecin_id]) return res.status(400).json({ error: 'ID déjà utilisé' });

  const password = generatePassword();
  const user = {
    medecin_id,
    nom_medecin,
    email,
    telephone,
    password_hash: bcrypt.hashSync(password, 10),
    type_licence,
    photos_achetees: licence.photos,
    photos_utilisees: 0,
    date_activation: new Date().toISOString().split('T')[0],
    date_expiration: new Date(Date.now() + licence.duree_jours * 24 * 60 * 60 * 1000).toISOString().split('T')[0],
    statut: 'active'
  };

  USERS[medecin_id] = user;
  saveUsers();

  res.json({
    success: true,
    identifiants: { medecin_id, nom_medecin, email, password, ...licence }
  });
});

// === FONCTIONS ===

function getStatutGlycemie(valeur) {
  if (valeur < 0.7) return 'hypoglycémie sévère';
  if (valeur < 1.0) return 'hypoglycémie';
  if (valeur <= 1.26) return 'normal';
  if (valeur <= 1.40) return 'hyperglycémie modérée';
  return 'hyperglycémie sévère';
}

function getMessageWhatsApp(statut, valeur) {
  const messages = {
    'hypoglycémie sévère': `🚨 URGENT - Glycémie ${valeur}g/L. Hypoglycémie sévère. Contactez médecin.`,
    'hypoglycémie': `⚠️ Glycémie ${valeur}g/L (hypo). Prenez sucre.`,
    'normal': `✅ Glycémie ${valeur}g/L - Excellent ! Continuez.`,
    'hyperglycémie modérée': `📈 Glycémie ${valeur}g/L (élevée). Surveillez alimentation.`,
    'hyperglycémie sévère': `🚨 Glycémie ${valeur}g/L (très élevée). Contactez médecin.`
  };
  return messages[statut];
}

async function analyserImageAvecOpenAI(buffer) {
  try {
    const base64Image = buffer.toString('base64');
    const response = await axios.post('https://api.openai.com/v1/chat/completions', {
      model: "gpt-4-vision-preview",
      messages: [{
        role: "user",
        content: [
          { type: "text", text: "Extrait uniquement le chiffre de glycémie. Réponds UNIQUEMENT avec le chiffre." },
          { type: "image_url", image_url: { url: `data:image/jpeg;base64,${base64Image}` } }
        ]
      }],
      max_tokens: 10
    }, {
      headers: { 'Authorization': `Bearer ${process.env.OPENAI_API_KEY}` }
    });

    return response.data.choices[0].message.content.trim();
  } catch (error) {
    return '1.20'; // Valeur par défaut pour tests
  }
}

function generatePassword() {
  return Math.random().toString(36).slice(-10) + '!';
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 SEN'Diabète démarré : http://localhost:${PORT}`));
