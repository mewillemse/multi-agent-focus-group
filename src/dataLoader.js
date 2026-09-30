const fs = require('fs');
const path = require('path');

function readJsonDirectory(folderPath) {
    if (!fs.existsSync(folderPath)) {
        return [];
    }

    return fs
        .readdirSync(folderPath)
        .filter((file) => file.endsWith('.json'))
        .map((file) => {
            const filePath = path.join(folderPath, file);
            const raw = fs.readFileSync(filePath, 'utf8');
            return JSON.parse(raw);
        });
}

function listPersonas() {
    const folderPath = path.join(__dirname, '..', 'data', 'personas');
    return readJsonDirectory(folderPath);
}

function listPanels() {
    const folderPath = path.join(__dirname, '..', 'data', 'panels');
    return readJsonDirectory(folderPath);
}

module.exports = { listPersonas, listPanels };
