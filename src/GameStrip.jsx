import React, { useRef, useEffect, useState } from "react";

function GameStrip({ children }) {
  const ref = useRef(null);
  const [hasScrolled, setHasScrolled] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const handleScroll = () => {
      setHasScrolled(el.scrollLeft > 5); // add class when first card moves left
    };
    el.addEventListener("scroll", handleScroll);
    handleScroll(); // initialize
    return () => el.removeEventListener("scroll", handleScroll);
  }, []);

  return (
    <div ref={ref} className={`gamesStrip ${hasScrolled ? "hasScrolled" : ""}`}>
      {children}
    </div>
  );
}
export default GameStrip;
