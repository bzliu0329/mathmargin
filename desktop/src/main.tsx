import React from "react";
import ReactDOM from "react-dom/client";
import "react-pdf/dist/Page/TextLayer.css";
import "katex/dist/katex.min.css";
import "../../app/globals.css";
import "./desktop.css";
import { DesktopApp } from "./DesktopApp";

ReactDOM.createRoot(document.getElementById("root")!).render(
  <React.StrictMode><DesktopApp /></React.StrictMode>,
);
