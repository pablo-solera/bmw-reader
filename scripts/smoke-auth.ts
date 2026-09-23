import { getAccessToken } from "../src/bmw/auth.js";

const token = await getAccessToken();
console.log(JSON.stringify({ authenticated: Boolean(token), tokenLength: token.length }));
