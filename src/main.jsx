import React from "react";
import { createRoot } from "react-dom/client";
import App from "./App.jsx";
import "./styles.css";
import { SettingsProvider } from "./settings";

createRoot(document.getElementById("root")).render(
  <SettingsProvider>
    <App />
  </SettingsProvider>
);
