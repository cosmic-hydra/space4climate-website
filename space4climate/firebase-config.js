/**
 * Space4Climate — Firebase Configuration
 * ============================================================
 * SETUP INSTRUCTIONS (one-time, ~5 minutes):
 *
 * 1. Go to https://console.firebase.google.com/
 * 2. Click "Add project", give it a name (e.g. "space4climate"), continue.
 * 3. In Project Overview → "Add app" → choose the web (</>)  icon.
 * 4. Register the app (any nickname), copy the firebaseConfig object.
 * 5. Replace EVERY "REPLACE_WITH_..." value below with your real values.
 *
 * 6. Enable Firestore:
 *    Firebase console → Build → Firestore Database → Create database
 *    Choose "Start in production mode", pick a region close to your users.
 *
 * 7. Set Firestore security rules (Rules tab):
 *    Paste the rules from the comment block at the bottom of this file.
 *
 * 8. Enable Authentication:
 *    Firebase console → Build → Authentication → Get started
 *    Sign-in method tab → enable "Email/Password".
 *
 * 9. (Optional) Add your domain to "Authorized domains" under
 *    Authentication → Settings → Authorized domains.
 *    Your GitHub Pages domain (e.g. space4climate.github.io) is
 *    needed for the password-reset email links to work.
 * ============================================================
 */
window.S4C_FIREBASE_CONFIG = {
  apiKey:            "REPLACE_WITH_YOUR_API_KEY",
  authDomain:        "REPLACE_WITH_YOUR_AUTH_DOMAIN",
  projectId:         "REPLACE_WITH_YOUR_PROJECT_ID",
  storageBucket:     "REPLACE_WITH_YOUR_STORAGE_BUCKET",
  messagingSenderId: "REPLACE_WITH_YOUR_MESSAGING_SENDER_ID",
  appId:             "REPLACE_WITH_YOUR_APP_ID"
};

/**
 * RECOMMENDED FIRESTORE SECURITY RULES
 * ─────────────────────────────────────
 * Paste these into Firebase console → Firestore → Rules:
 *
 * rules_version = '2';
 * service cloud.firestore {
 *   match /databases/{database}/documents {
 *
 *     // CommonBoard bookings – public read; anyone can create/delete
 *     // Tighten later if needed (e.g. require auth for delete).
 *     match /bookings/{slotId} {
 *       allow read:   if true;
 *       allow create: if true;
 *       allow delete: if true;
 *       allow update: if false;
 *     }
 *
 *     // Student profiles – only the authenticated user can read/write their own doc
 *     match /users/{userId} {
 *       allow read, write: if request.auth != null && request.auth.uid == userId;
 *     }
 *   }
 * }
 */
