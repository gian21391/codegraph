function f(p)
s.predict = @(v) v * 2;
y = s.predict(3);
cfg = struct('predict', @sin);
z = cfg.predict(3);
end
