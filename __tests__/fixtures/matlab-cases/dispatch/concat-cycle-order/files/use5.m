function use5(n)
k = Gizmo();
w = Gizmo();
for i = 1:n
  k = [k, w];
  w = [w, k];
end
tidy(k);
tidy(w);
zt(1);
end
