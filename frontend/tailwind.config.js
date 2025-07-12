/** @type {import('tailwindcss').Config} */
export default {
"content": [
"./src/**/*.{js,jsx,ts,tsx}"
],
"theme": {
"extend": {
"colors": {
"gray": {
"100": "#1f1f22",
"200": "#09090a"
},
"mediumseagreen": "#14ae5c",
"whitesmoke": "#efefef",
"silver": "#c0bfbd",
"aquamarine": "#aff4c6"
},
"fontFamily": {
"open-sans": "Open Sans"
}
}
},
"corePlugins": {
"preflight": false
}
}