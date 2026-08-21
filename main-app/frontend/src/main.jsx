import React from 'react';
import { createRoot } from 'react-dom/client';
import { ColorSchemeScript } from '@mantine/core';
import App from './App';

createRoot(document.getElementById('root')).render(
  <React.StrictMode>
    {/* Dat mau nen truoc khi React ve, tranh nhay trang mot nhip khi tai lai. */}
    <ColorSchemeScript defaultColorScheme="dark" />
    <App />
  </React.StrictMode>
);
