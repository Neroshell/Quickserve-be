export function deriveCountryCode(countryString) {
    if (!countryString || typeof countryString !== "string") {
        return "mt"
    }

    const str = countryString.trim().toLowerCase()
    if (str.length === 2) {
        return str
    }

    const countryMap = {
        "malta": "mt",
        "ireland": "ie",
        "france": "fr",
        "united kingdom": "gb",
        "uk": "gb",
        "united states": "us",
        "usa": "us",
        "germany": "de",
        "spain": "es",
        "italy": "it",
        "australia": "au",
        "canada": "ca",
        "mexico": "mx",
        "india": "in",
        "japan": "jp",
        "brazil": "br",
        "nigeria": "ng",
        "ghana": "gh"
    }

    return countryMap[str] || "mt"
}
