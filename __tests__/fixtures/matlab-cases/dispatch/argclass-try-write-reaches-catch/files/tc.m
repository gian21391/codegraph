function tc()
g = gadget();
try
  g = 5;
  error('stop');
catch
  tidy(g);
end
end
