import { createApp } from "vue";
import { createRouter, createWebHistory } from "vue-router";
import App from "./App.vue";
import Landing from "./pages/Landing.vue";

const router = createRouter({
  history: createWebHistory(),
  routes: [{ path: "/", name: "landing", component: Landing }],
});

createApp(App).use(router).mount("#app");
