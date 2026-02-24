import { initializeApp } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-app.js";
import { getAuth } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-auth.js";
import { getFirestore } from "https://www.gstatic.com/firebasejs/12.9.0/firebase-firestore.js";

const firebaseConfig = {
    apiKey: "AIzaSyCGHXGTomxpmaHH61GOR8YFSflF-qIt0PU",
    authDomain: "room-note-6c195.firebaseapp.com",
    projectId: "room-note-6c195",
    storageBucket: "room-note-6c195.firebasestorage.app",
    messagingSenderId: "1075825931481",
    appId: "1:1075825931481:web:2c2b6246a08a9e4a5abac8",
    measurementId: "G-JN4REHJZS7"
};

// Initialize Firebase
const app = initializeApp(firebaseConfig);
export const auth = getAuth(app);
export const db = getFirestore(app);
