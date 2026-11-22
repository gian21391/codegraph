function gui()
cb();
    function cb()
        inner();
        function inner()
        end
    end
    function sib()
        cb();
    end
end
function other()
cb();
inner();
end
