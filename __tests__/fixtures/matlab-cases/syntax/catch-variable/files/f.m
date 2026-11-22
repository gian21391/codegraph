function f()
try
    risky();
catch
    cleanupAll
end
try
    risky();
catch ME
    report(ME);
end
ME(1);
end
