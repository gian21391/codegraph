function this = chk(this)
[ok, this] = helper2(struct(this));
this = Gizmo(this);
tidy(this);
end
