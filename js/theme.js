// WheelHouse Theme Settings
// Handles color customization with presets and localStorage persistence

(function() {
    // Default theme colors
    const defaultTheme = {
        '--bg-primary': '#1a1a2e',
        '--bg-secondary': '#0a0a15',
        '--bg-card': 'rgba(0,0,0,0.3)',
        '--accent-cyan': '#00d9ff',
        '--accent-green': '#00ff88',
        '--accent-red': '#ff5252',
        '--accent-orange': '#ffaa00',
        '--accent-purple': '#8b5cf6',
        '--text-primary': '#e8e8e8',
        '--text-muted': '#888',
        '--border-color': 'rgba(255,255,255,0.1)'
    };

    // Preset themes
    const presets = {
        dark: { ...defaultTheme },
        midnight: {
            '--bg-primary': '#0d1421',
            '--bg-secondary': '#060a10',
            '--bg-card': 'rgba(0,0,0,0.4)',
            '--accent-cyan': '#4ecdc4',
            '--accent-green': '#26de81',
            '--accent-red': '#fc5c65',
            '--accent-orange': '#fd9644',
            '--accent-purple': '#a55eea',
            '--text-primary': '#f0f0f0',
            '--text-muted': '#6b7280',
            '--border-color': 'rgba(255,255,255,0.08)'
        },
        ocean: {
            '--bg-primary': '#0a192f',
            '--bg-secondary': '#020c1b',
            '--bg-card': 'rgba(0,0,0,0.3)',
            '--accent-cyan': '#64ffda',
            '--accent-green': '#56ffa4',
            '--accent-red': '#ff6b6b',
            '--accent-orange': '#ffd93d',
            '--accent-purple': '#bd93f9',
            '--text-primary': '#ccd6f6',
            '--text-muted': '#8892b0',
            '--border-color': 'rgba(100,255,218,0.1)'
        },
        neon: {
            '--bg-primary': '#1a0a2e',
            '--bg-secondary': '#0d0518',
            '--bg-card': 'rgba(0,0,0,0.4)',
            '--accent-cyan': '#00fff5',
            '--accent-green': '#39ff14',
            '--accent-red': '#ff073a',
            '--accent-orange': '#ff6700',
            '--accent-purple': '#bc13fe',
            '--text-primary': '#ffffff',
            '--text-muted': '#a0a0a0',
            '--border-color': 'rgba(188,19,254,0.2)'
        }
    };

    // Color picker configuration
    const colorConfig = [
        { key: '--bg-primary', label: 'Background Primary', type: 'color' },
        { key: '--bg-secondary', label: 'Background Dark', type: 'color' },
        { key: '--accent-cyan', label: 'Accent Cyan', type: 'color' },
        { key: '--accent-green', label: 'Success Green', type: 'color' },
        { key: '--accent-red', label: 'Danger Red', type: 'color' },
        { key: '--accent-orange', label: 'Warning Orange', type: 'color' },
        { key: '--accent-purple', label: 'Spread Purple', type: 'color' },
        { key: '--text-primary', label: 'Text Primary', type: 'color' },
        { key: '--text-muted', label: 'Text Muted', type: 'color' }
    ];

    // Load saved theme on startup
    function loadTheme() {
        const saved = localStorage.getItem('wheelhouse_theme');
        if (saved) {
            try {
                const theme = JSON.parse(saved);
                applyTheme(theme);
            } catch (e) {
                console.error('Failed to load theme:', e);
            }
        }
    }

    // Apply theme to document
    function applyTheme(theme) {
        const root = document.documentElement;
        Object.entries(theme).forEach(([key, value]) => {
            root.style.setProperty(key, value);
        });
    }

    // Save current theme
    function saveTheme(theme) {
        localStorage.setItem('wheelhouse_theme', JSON.stringify(theme));
    }

    // Get current theme from CSS
    function getCurrentTheme() {
        const root = document.documentElement;
        const style = getComputedStyle(root);
        const theme = {};
        Object.keys(defaultTheme).forEach(key => {
            theme[key] = style.getPropertyValue(key).trim() || defaultTheme[key];
        });
        return theme;
    }

    // Show settings modal
    window.showSettingsModal = function() {
        // Remove existing modal
        const existing = document.getElementById('settingsModal');
        if (existing) existing.remove();

        const currentTheme = getCurrentTheme();

        const modal = document.createElement('div');
        modal.id = 'settingsModal';
        modal.style.cssText = `
            position: fixed; top: 0; left: 0; right: 0; bottom: 0;
            background: rgba(0,0,0,0.85); display: flex; align-items: center;
            justify-content: center; z-index: 10000;
        `;
        modal.onclick = (e) => { if (e.target === modal) modal.remove(); };

        modal.innerHTML = `
            <div style="background: var(--bg-primary); border-radius: 12px; width: 420px; max-height: 80vh; overflow-y: auto; box-shadow: 0 20px 60px rgba(0,0,0,0.5); border: 1px solid var(--border-color);">
                <div style="padding: 20px; border-bottom: 1px solid var(--border-color); display: flex; justify-content: space-between; align-items: center;">
                    <h2 style="color: var(--accent-cyan); margin: 0; font-size: 18px;">⚙️ Theme Settings</h2>
                    <button onclick="document.getElementById('settingsModal').remove()" style="background: none; border: none; color: var(--text-muted); font-size: 24px; cursor: pointer; line-height: 1;">&times;</button>
                </div>
                
                <div style="padding: 20px;">
                    <!-- Preset Buttons -->
                    <div style="margin-bottom: 20px;">
                        <label style="color: var(--text-muted); font-size: 12px; display: block; margin-bottom: 8px;">PRESETS</label>
                        <div style="display: grid; grid-template-columns: repeat(4, 1fr); gap: 8px;">
                            ${Object.keys(presets).map(name => `
                                <button onclick="applyPreset('${name}')" style="background: var(--bg-secondary); border: 1px solid var(--border-color); color: var(--text-primary); padding: 8px; border-radius: 6px; cursor: pointer; font-size: 12px; text-transform: capitalize;">
                                    ${name}
                                </button>
                            `).join('')}
                        </div>
                    </div>
                    
                    <!-- Color Pickers -->
                    <div style="margin-bottom: 20px;">
                        <label style="color: var(--text-muted); font-size: 12px; display: block; margin-bottom: 12px;">CUSTOM COLORS</label>
                        <div style="display: grid; gap: 10px;">
                            ${colorConfig.map(({ key, label }) => `
                                <div style="display: flex; align-items: center; justify-content: space-between;">
                                    <span style="color: var(--text-primary); font-size: 13px;">${label}</span>
                                    <div style="display: flex; align-items: center; gap: 8px;">
                                        <input type="color" id="color_${key}" value="${rgbaToHex(currentTheme[key])}" 
                                            onchange="updateColor('${key}', this.value)"
                                            style="width: 40px; height: 28px; border: none; border-radius: 4px; cursor: pointer; background: transparent;">
                                        <span id="hex_${key}" style="color: var(--text-muted); font-size: 11px; font-family: monospace; width: 60px;">${rgbaToHex(currentTheme[key])}</span>
                                    </div>
                                </div>
                            `).join('')}
                        </div>
                    </div>
                    
                    <!-- Action Buttons -->
                    <div style="display: flex; gap: 10px; justify-content: flex-end; padding-top: 15px; border-top: 1px solid var(--border-color);">
                        <button onclick="resetTheme()" style="background: var(--bg-secondary); border: 1px solid var(--border-color); color: var(--text-muted); padding: 10px 20px; border-radius: 6px; cursor: pointer;">
                            Reset
                        </button>
                        <button onclick="saveCurrentTheme(); document.getElementById('settingsModal').remove();" style="background: var(--accent-cyan); border: none; color: #000; padding: 10px 20px; border-radius: 6px; cursor: pointer; font-weight: 600;">
                            Save Theme
                        </button>
                    </div>
                </div>
            </div>
        `;

        document.body.appendChild(modal);
    };

    // Convert rgba/color to hex
    function rgbaToHex(color) {
        if (!color) return '#000000';
        if (color.startsWith('#')) return color.substring(0, 7); // Already hex
        if (color.startsWith('rgba')) {
            // Parse rgba
            const match = color.match(/rgba?\((\d+),\s*(\d+),\s*(\d+)/);
            if (match) {
                return '#' + [match[1], match[2], match[3]].map(x => {
                    const hex = parseInt(x).toString(16);
                    return hex.length === 1 ? '0' + hex : hex;
                }).join('');
            }
        }
        return color;
    }

    // Update a single color
    window.updateColor = function(key, value) {
        document.documentElement.style.setProperty(key, value);
        const hexSpan = document.getElementById('hex_' + key);
        if (hexSpan) hexSpan.textContent = value;
    };

    // Apply a preset theme
    window.applyPreset = function(name) {
        const theme = presets[name];
        if (theme) {
            applyTheme(theme);
            // Update color pickers in modal
            colorConfig.forEach(({ key }) => {
                const input = document.getElementById('color_' + key);
                const hexSpan = document.getElementById('hex_' + key);
                if (input && theme[key]) {
                    input.value = rgbaToHex(theme[key]);
                    if (hexSpan) hexSpan.textContent = rgbaToHex(theme[key]);
                }
            });
        }
    };

    // Reset to default
    window.resetTheme = function() {
        applyTheme(defaultTheme);
        localStorage.removeItem('wheelhouse_theme');
        // Update color pickers
        colorConfig.forEach(({ key }) => {
            const input = document.getElementById('color_' + key);
            const hexSpan = document.getElementById('hex_' + key);
            if (input) {
                input.value = rgbaToHex(defaultTheme[key]);
                if (hexSpan) hexSpan.textContent = rgbaToHex(defaultTheme[key]);
            }
        });
    };

    // Save current theme
    window.saveCurrentTheme = function() {
        const theme = getCurrentTheme();
        saveTheme(theme);
    };

    // Load theme when DOM ready
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', loadTheme);
    } else {
        loadTheme();
    }
})();
