import { defineConfig } from "vite";

export default defineConfig({
	// GitHub Pages 项目页部署在 /pi-browser/ 子路径下,资源引用必须相对化
	base: "./",
	build: {
		target: "es2022",
	},
});
