function use6(n)
k = Gizmo();
w = Gizmo();
for i = 1:n
  k = [k, w];
  w = [w, k];
end
tidy(w);
tidy(k);
end
